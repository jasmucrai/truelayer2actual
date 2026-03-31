import 'dotenv/config';
import readline from 'readline';
import { execFile } from 'child_process';
import axios from 'axios';
import { startAuthServer } from '../auth/server.js';
import {
  generateConnectionId,
  saveConnection,
  removeStaleConnections,
  type Tokens,
} from '../auth/tokens.js';
import {
  fetchAccounts,
  fetchCards,
  type TrueLayerAccount,
  type TrueLayerCard,
} from '../clients/truelayer.js';
import {
  initActual,
  shutdownActual,
  getActualAccounts,
  type ActualAccount,
} from '../clients/actual.js';
import { loadConfig, saveConfig, type Config, type Account } from '../config.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'Please copy .env.example to .env and fill in the values.'
    );
  }
  return value;
}

function isSandbox(clientId: string): boolean {
  return clientId.startsWith('sandbox-');
}

function buildAuthUrl(clientId: string, redirectUri: string, sandbox: boolean): string {
  const base = sandbox ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'accounts balance transactions cards offline_access',
    redirect_uri: redirectUri,
    providers: 'uk-ob-all uk-oauth-all',
    prompt: 'consent',
  });
  return `${base}/?${params.toString()}`;
}

function tokenUrl(sandbox: boolean): string {
  return sandbox
    ? 'https://auth.truelayer-sandbox.com/connect/token'
    : 'https://auth.truelayer.com/connect/token';
}

function tryOpenBrowser(url: string): void {
  execFile('open', [url], () => { /* ignore errors */ });
}

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
  const { server, waitForCode } = await startAuthServer(port);

  const authUrl = buildAuthUrl(clientId, redirectUri, sandbox);

  console.log('\n===========================================================');
  console.log(`Bank ${bankNumber}: Open this URL to authenticate:`);
  console.log('\n' + authUrl + '\n');
  console.log('===========================================================\n');

  tryOpenBrowser(authUrl);
  logger.info('Waiting for OAuth callback...');

  let code: string;
  try {
    code = await waitForCode();
  } catch (err) {
    server.close();
    throw new Error(`OAuth flow failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  server.close();

  // Exchange code for tokens
  logger.info('Exchanging authorization code for tokens...');
  let tokenData: { access_token: string; refresh_token: string; expires_in: number };

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    const res = await axios.post<typeof tokenData>(
      tokenUrl(sandbox),
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokenData = res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw new Error(
        `Token exchange failed: ${err.response?.status ?? 'unknown'} — ${JSON.stringify(err.response?.data)}`
      );
    }
    throw err;
  }

  const tokens: Tokens = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
  };

  const connectionId = generateConnectionId();
  saveConnection(connectionId, tokens);
  logger.info(`Tokens saved (connection: ${connectionId})`);

  logger.info('Fetching accounts and cards from TrueLayer...');
  const [tlAccounts, tlCards] = await Promise.all([
    fetchAccounts(tokenData.access_token),
    fetchCards(tokenData.access_token),
  ]);
  logger.info(`Found ${tlAccounts.length} account(s) and ${tlCards.length} card(s)`);

  return { connectionId, tlAccounts, tlCards };
}

// ---------------------------------------------------------------------------
// Interactive account picker (shared for accounts and cards)
// ---------------------------------------------------------------------------

async function pickActualAccount(
  rl: readline.Interface,
  actualAccounts: ActualAccount[],
  label: string
): Promise<ActualAccount | null> {
  console.log(`\n${label}`);
  console.log('Actual accounts:');
  actualAccounts.forEach((a, i) => {
    console.log(`  ${i + 1}. ${a.name}${a.offbudget ? ' (off-budget)' : ''}`);
  });

  while (true) {
    const answer = await prompt(rl, `Select [1-${actualAccounts.length} / s to skip]: `);
    if (answer.toLowerCase() === 's') {
      logger.info(`Skipped: ${label}`);
      return null;
    }
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= actualAccounts.length) {
      return actualAccounts[num - 1];
    }
    console.log(`Invalid. Enter 1–${actualAccounts.length} or "s".`);
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
  requireEnv('ACTUAL_SYNC_ID');

  const port = parseInt(process.env.SETUP_PORT ?? '3000', 10);
  const sandbox = isSandbox(clientId);

  logger.info(`Using TrueLayer ${sandbox ? 'SANDBOX' : 'LIVE'} environment`);

  // Collect connections from one or more banks
  const allConnections: Array<{
    connectionId: string;
    tlAccounts: TrueLayerAccount[];
    tlCards: TrueLayerCard[];
  }> = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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
    rl.close();
    process.exit(0);
  }

  // Connect to Actual and get accounts for pairing
  logger.info('Connecting to Actual Budget...');
  await initActual();
  const actualAccounts = await getActualAccounts();
  await shutdownActual();

  if (actualAccounts.length === 0) {
    logger.error(
      'No open accounts found in Actual Budget. ' +
        'Please create accounts in Actual first, then re-run setup.'
    );
    rl.close();
    process.exit(1);
  }

  logger.info(`Found ${actualAccounts.length} Actual account(s)`);

  // Interactive pairing across all connections
  const pairedAccounts: Account[] = [];

  console.log('\n===========================================================');
  console.log('Account Pairing');
  console.log('===========================================================');
  console.log('For each bank account, choose the matching Actual account.');
  console.log('Enter the number, or "s" to skip.\n');

  for (const { connectionId, tlAccounts, tlCards } of allConnections) {
    // Pair bank accounts
    for (const tlAccount of tlAccounts) {
      const picked = await pickActualAccount(
        rl,
        actualAccounts,
        `${tlAccount.provider.display_name} — ${tlAccount.display_name} (${tlAccount.account_type}) [${tlAccount.currency}]`
      );
      if (picked) {
        pairedAccounts.push({
          name: tlAccount.display_name,
          connectionId,
          accountKind: 'account' as const,
          truelayerAccountId: tlAccount.account_id,
          actualAccountId: picked.id,
          currency: tlAccount.currency,
        });
        logger.info(`Paired: "${tlAccount.display_name}" → "${picked.name}"`);
      }
    }

    // Pair cards
    for (const tlCard of tlCards) {
      const label = `${tlCard.provider.display_name} — ${tlCard.display_name}` +
        (tlCard.partial_card_number ? ` (****${tlCard.partial_card_number})` : '') +
        ` [${tlCard.card_type}] [${tlCard.currency}]`;
      const picked = await pickActualAccount(rl, actualAccounts, label);
      if (picked) {
        pairedAccounts.push({
          name: tlCard.display_name,
          connectionId,
          accountKind: 'card' as const,
          truelayerAccountId: tlCard.account_id,
          actualAccountId: picked.id,
          currency: tlCard.currency,
        });
        logger.info(`Paired card: "${tlCard.display_name}" → "${picked.name}"`);
      }
    }
  }

  rl.close();

  if (pairedAccounts.length === 0) {
    logger.warn('No accounts were paired. Exiting without saving config.');
    process.exit(0);
  }

  // Load existing config to preserve lastSyncedAt for re-authenticated accounts
  let existingConfig: Config | null = null;
  try {
    existingConfig = await loadConfig();
  } catch {
    // First run
  }

  const finalAccounts: Account[] = pairedAccounts.map((account) => {
    const existing = existingConfig?.accounts.find(
      (a) => a.truelayerAccountId === account.truelayerAccountId
    );
    return existing ? { ...existing, ...account } : account;
  });

  const config: Config = {
    accounts: finalAccounts,
    createdAt: existingConfig?.createdAt ?? new Date().toISOString(),
  };
  await saveConfig(config);
  logger.info(`Config saved (${finalAccounts.length} account(s))`);

  // Remove token connections that are no longer referenced
  const activeConnectionIds = new Set(finalAccounts.map((a) => a.connectionId));
  removeStaleConnections(activeConnectionIds);

  console.log('\n===========================================================');
  console.log('Setup complete!');
  console.log('===========================================================');
  console.log(`\nPaired ${pairedAccounts.length} account(s):`);
  pairedAccounts.forEach((a) => console.log(`  - ${a.name}`));
  console.log('\nNext steps:');
  console.log('  npm run sync              # sync now');
  console.log('  npm run setup             # add more banks anytime\n');
}

main().catch((err) => {
  logger.error('Setup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
