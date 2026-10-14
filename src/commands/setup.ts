import 'dotenv/config';
import readline from 'readline';
import { startAuthServer } from '../auth/server.js';
import {
  generateConnectionId,
  saveConnection,
  removeStaleConnections,
  type Tokens,
} from '../auth/tokens.js';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchTrueLayerAccounts,
  isSandbox,
  requireEnv,
} from '../auth/oauth.js';
import {
  type TrueLayerAccount,
  type TrueLayerCard,
} from '../clients/truelayer.js';
import {
  switchBudget,
  shutdownActual,
  getActualAccounts,
  type ActualAccount,
} from '../clients/actual.js';
import {
  loadConfigIfExists,
  saveConfig,
  mergeAccounts,
  budgetFromEnv,
  generateBudgetId,
  findBudgetBySyncId,
  DuplicateSyncIdError,
  type Config,
  type Account,
  type Budget,
} from '../config.js';
import { logger } from '../logger.js';
import { describeError } from '../util/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ---------------------------------------------------------------------------
// Single OAuth session: authenticate one bank, return connection id + accounts
// ---------------------------------------------------------------------------

async function authenticateBank(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  port: number,
  sandbox: boolean,
  bankNumber: number
): Promise<{ connectionId: string; tlAccounts: TrueLayerAccount[]; tlCards: TrueLayerCard[] }> {
  const { server, waitForCode, authState } = await startAuthServer(port);

  const authUrl = buildAuthUrl(clientId, redirectUri, sandbox, authState);

  console.log('\n===========================================================');
  console.log(`Bank ${bankNumber}: Open this URL to authenticate:`);
  console.log('\n' + authUrl + '\n');
  console.log('===========================================================\n');

  logger.info('Waiting for OAuth callback...');

  let code: string;
  try {
    code = await waitForCode();
  } catch (err) {
    server.close();
    throw new Error(`OAuth flow failed: ${describeError(err)}`);
  }

  server.close();

  // Exchange code for tokens
  logger.info('Exchanging authorization code for tokens...');
  const tokens: Tokens = await exchangeCodeForTokens({
    clientId,
    clientSecret,
    redirectUri,
    code,
    sandbox,
  });

  const connectionId = generateConnectionId();
  saveConnection(connectionId, tokens);
  logger.info(`Tokens saved (connection: ${connectionId})`);

  logger.info('Fetching accounts and cards from TrueLayer...');
  const { accounts: tlAccounts, cards: tlCards } = await fetchTrueLayerAccounts(
    tokens.accessToken
  );
  logger.info(`Found ${tlAccounts.length} account(s) and ${tlCards.length} card(s)`);

  return { connectionId, tlAccounts, tlCards };
}

// ---------------------------------------------------------------------------
// Interactive account picker (shared for accounts and cards)
// ---------------------------------------------------------------------------

async function fetchActualAccounts(budget: Budget): Promise<ActualAccount[]> {
  await switchBudget(budget);
  return getActualAccounts();
}

// ---------------------------------------------------------------------------
// Budget collection / selection
// ---------------------------------------------------------------------------

async function collectBudgets(rl: readline.Interface): Promise<Budget[]> {
  const budgets: Budget[] = [];
  const envBudget = budgetFromEnv();
  if (envBudget) budgets.push(envBudget);

  console.log('\n===========================================================');
  console.log('Actual Budgets');
  console.log('===========================================================');
  if (budgets.length > 0) {
    console.log('Found default budget from ACTUAL_SYNC_ID.');
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log('\nCurrent budgets:');
    budgets.forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.name} (${b.syncId})`);
    });

    const add = await prompt(rl, 'Add another budget? [y/N]: ');
    if (add.toLowerCase() !== 'y') break;

    const name = await prompt(rl, 'Budget name: ');
    const syncId = await prompt(rl, 'Sync ID (Actual → Settings → Advanced): ');
    if (!name || !syncId) {
      logger.warn('Budget name and sync ID are both required.');
      continue;
    }
    const clash = findBudgetBySyncId(budgets, syncId);
    if (clash) {
      logger.warn(new DuplicateSyncIdError(syncId, clash).message);
      continue;
    }
    const encryptionPassword = await prompt(
      rl,
      'Encryption password (blank if E2E encryption is off): '
    );
    budgets.push({
      id: generateBudgetId(),
      name,
      syncId,
      encryptionPassword: encryptionPassword || undefined,
    });
  }

  return budgets;
}

async function pickBudget(
  rl: readline.Interface,
  budgets: Budget[],
  label: string
): Promise<Budget> {
  console.log(`\n${label}`);
  budgets.forEach((b, i) => {
    console.log(`  ${i + 1}. ${b.name} (${b.syncId})`);
  });

  while (true) {
    const answer = await prompt(rl, `Select budget [1-${budgets.length}]: `);
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= budgets.length) {
      return budgets[num - 1];
    }
    console.log(`Invalid. Enter 1–${budgets.length}.`);
  }
}

async function pickActualAccount(
  rl: readline.Interface,
  label: string,
  refresh: () => Promise<ActualAccount[]>
): Promise<ActualAccount | null> {
  let accounts = await refresh();

  function printAccounts(): void {
    console.log(`\n${label}`);
    console.log('Actual accounts:');
    accounts.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.name}${a.offbudget ? ' (off-budget)' : ''}`);
    });
  }

  if (accounts.length === 0) {
    logger.warn(`No open accounts found for "${label}" — skipping.`);
    return null;
  }

  printAccounts();

  while (true) {
    const answer = await prompt(rl, `Select [1-${accounts.length} / s to skip / r to refresh]: `);
    if (answer.toLowerCase() === 's') {
      logger.info(`Skipped: ${label}`);
      return null;
    }
    if (answer.toLowerCase() === 'r') {
      logger.info('Refreshing Actual accounts...');
      accounts = await refresh();
      if (accounts.length === 0) {
        logger.warn(`No open accounts found for "${label}" — skipping.`);
        return null;
      }
      printAccounts();
      continue;
    }
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= accounts.length) {
      return accounts[num - 1];
    }
    console.log(`Invalid. Enter 1–${accounts.length}, "s" to skip, or "r" to refresh.`);
  }
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('Starting truelayer2actual setup...');

  const clientId = requireEnv('TRUELAYER_CLIENT_ID');
  const clientSecret = requireEnv('TRUELAYER_CLIENT_SECRET');
  const redirectUri = requireEnv('TRUELAYER_REDIRECT_URI');
  requireEnv('ACTUAL_SERVER_URL');
  requireEnv('ACTUAL_PASSWORD');

  const port = parseInt(process.env.SETUP_PORT ?? '3000', 10);
  const sandbox = isSandbox(clientId);

  logger.info(`Using TrueLayer ${sandbox ? 'SANDBOX' : 'LIVE'} environment`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Collect the Actual budgets to sync into.
    const budgets = await collectBudgets(rl);
    if (budgets.length === 0) {
      logger.error('No budgets defined. Set ACTUAL_SYNC_ID or add a budget during setup.');
      process.exitCode = 1;
      return;
    }

    // Collect connections from one or more banks
    const allConnections: Array<{
      connectionId: string;
      tlAccounts: TrueLayerAccount[];
      tlCards: TrueLayerCard[];
    }> = [];

    let bankNumber = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { connectionId, tlAccounts, tlCards } = await authenticateBank(
        clientId,
        clientSecret,
        redirectUri,
        port,
        sandbox,
        bankNumber
      );

      if (tlAccounts.length === 0 && tlCards.length === 0) {
        logger.warn('No accounts or cards returned for this bank — skipping.');
      } else {
        allConnections.push({ connectionId, tlAccounts, tlCards });
      }

      bankNumber++;

      const another = await prompt(rl, '\nAdd another bank? [y/N]: ');
      if (another.toLowerCase() !== 'y') break;
    }

    if (allConnections.length === 0) {
      logger.warn('No bank connections established. Exiting.');
      return;
    }

    // Interactive pairing across all connections
    const pairedAccounts: Account[] = [];

    console.log('\n===========================================================');
    console.log('Account Pairing');
    console.log('===========================================================');
    console.log('For each bank account, choose the Actual budget, then the matching Actual account.');
    console.log('Enter the number, "s" to skip, or "r" to refresh the Actual account list.\n');

    const accountsCache = new Map<string, ActualAccount[]>();

    async function accountsForBudget(budget: Budget): Promise<ActualAccount[]> {
      const cached = accountsCache.get(budget.id);
      if (cached) return cached;
      const accounts = await fetchActualAccounts(budget);
      accountsCache.set(budget.id, accounts);
      return accounts;
    }

    for (const { connectionId, tlAccounts, tlCards } of allConnections) {
      // Pair bank accounts
      for (const tlAccount of tlAccounts) {
        const budget = await pickBudget(
          rl,
          budgets,
          `Which Actual budget should "${tlAccount.display_name}" sync into?`
        );
        const picked = await pickActualAccount(
          rl,
          `${tlAccount.provider.display_name} — ${tlAccount.display_name} (${tlAccount.account_type}) [${tlAccount.currency}]`,
          () => accountsForBudget(budget)
        );
        if (picked) {
          pairedAccounts.push({
            name: tlAccount.display_name,
            connectionId,
            budgetId: budget.id,
            accountKind: 'account' as const,
            truelayerAccountId: tlAccount.account_id,
            actualAccountId: picked.id,
            currency: tlAccount.currency,
          });
          logger.info(`Paired: "${tlAccount.display_name}" → "${picked.name}" (${budget.name})`);
        }
      }

      // Pair cards
      for (const tlCard of tlCards) {
        const budget = await pickBudget(
          rl,
          budgets,
          `Which Actual budget should "${tlCard.display_name}" sync into?`
        );
        const label = `${tlCard.provider.display_name} — ${tlCard.display_name}` +
          (tlCard.partial_card_number ? ` (****${tlCard.partial_card_number})` : '') +
          ` [${tlCard.card_type}] [${tlCard.currency}]`;
        const picked = await pickActualAccount(rl, label, () => accountsForBudget(budget));
        if (picked) {
          pairedAccounts.push({
            name: tlCard.display_name,
            connectionId,
            budgetId: budget.id,
            accountKind: 'card' as const,
            truelayerAccountId: tlCard.account_id,
            actualAccountId: picked.id,
            currency: tlCard.currency,
          });
          logger.info(`Paired card: "${tlCard.display_name}" → "${picked.name}" (${budget.name})`);
        }
      }
    }

    if (pairedAccounts.length === 0) {
      logger.warn('No accounts were paired. Exiting without saving config.');
      return;
    }

    // Load existing config to preserve lastSyncedAt for re-authenticated accounts.
    // A config.json that exists but cannot be loaded is a hard error: treating it
    // as a first run would overwrite it with only the new pairings and then delete
    // every other bank's tokens.
    let existingConfig: Config | null;
    try {
      existingConfig = await loadConfigIfExists();
    } catch (err) {
      logger.error(
        'Config file exists but could not be loaded:',
        describeError(err)
      );
      process.exitCode = 1;
      return;
    }

    // Merge: keep existing accounts, overwrite any that were re-paired, append new ones
    const existingAccounts = existingConfig?.accounts ?? [];
    const mergedAccounts = mergeAccounts(existingAccounts, pairedAccounts);

    // Merge budgets: keep any previously configured, override/append the ones
    // collected now so env changes and new budgets both take effect.
    const existingBudgets = existingConfig?.budgets ?? [];
    const mergedBudgets = [...existingBudgets];
    for (const budget of budgets) {
      const idx = mergedBudgets.findIndex((b) => b.id === budget.id);
      if (idx === -1) mergedBudgets.push(budget);
      else mergedBudgets[idx] = budget;
    }

    const config: Config = {
      budgets: mergedBudgets,
      accounts: mergedAccounts,
      createdAt: existingConfig?.createdAt ?? new Date().toISOString(),
    };
    await saveConfig(config);
    logger.info(`Config saved (${mergedAccounts.length} account(s) across ${mergedBudgets.length} budget(s))`);

    // Remove token connections that are no longer referenced
    const activeConnectionIds = new Set(mergedAccounts.map((a) => a.connectionId));
    removeStaleConnections(activeConnectionIds);

    console.log('\n===========================================================');
    console.log('Setup complete!');
    console.log('===========================================================');
    console.log(`\nPaired ${pairedAccounts.length} new/updated account(s):`);
    pairedAccounts.forEach((a) => console.log(`  - ${a.name}`));
    console.log('\nNext steps:');
    console.log('  npm run sync              # sync now');
    console.log('  npm run setup             # add more banks anytime\n');
  } finally {
    rl.close();
    await shutdownActual();
  }
}

main().catch((err) => {
  logger.error('Setup failed:', describeError(err));
  process.exit(1);
});
