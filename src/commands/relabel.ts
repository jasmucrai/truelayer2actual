import 'dotenv/config';
import { loadConfig, saveConfig } from '../config.js';
import { loadConnection, refreshConnectionIfNeeded } from '../auth/tokens.js';
import { fetchAccounts, fetchCards } from '../clients/truelayer.js';
import { initActual, shutdownActual, getActualAccounts } from '../clients/actual.js';
import { logger } from '../logger.js';

// Backfills the provider and Actual account names onto pairings that predate
// those fields, and re-syncs them for anything renamed in Actual since. Both
// are display-only, so this never touches a watermark or a transaction - the
// worst a bad run can do is leave a label stale.

async function main(): Promise<void> {
  logger.info('Starting truelayer2actual relabel...');

  const config = await loadConfig();

  if (config.accounts.length === 0) {
    logger.warn('No accounts configured. Run "just add" to pair accounts first.');
    process.exit(0);
  }

  // One token covers one bank, and the accounts and cards endpoints both carry
  // the provider, so a single pass per connection labels everything under it.
  const providers = new Map<string, string>();
  const names = new Map<string, string>();
  const cardNumbers = new Map<string, string>();
  const connectionIds = [...new Set(config.accounts.map((a) => a.connectionId))];

  for (const connectionId of connectionIds) {
    const tokens = loadConnection(connectionId);
    const accessToken = await refreshConnectionIfNeeded(connectionId, tokens);

    for (const tl of await fetchAccounts(accessToken)) {
      providers.set(tl.account_id, tl.provider.display_name);
      names.set(tl.account_id, tl.display_name);
    }
    for (const tl of await fetchCards(accessToken)) {
      providers.set(tl.account_id, tl.provider.display_name);
      names.set(tl.account_id, tl.display_name);
      if (tl.partial_card_number) cardNumbers.set(tl.account_id, tl.partial_card_number);
    }
  }

  await initActual();
  let actualNames: Map<string, string>;
  try {
    actualNames = new Map((await getActualAccounts()).map((a) => [a.id, a.name]));
  } finally {
    await shutdownActual();
  }

  let changed = 0;

  for (const account of config.accounts) {
    const provider = providers.get(account.truelayerAccountId);
    const name = names.get(account.truelayerAccountId);
    const actualName = actualNames.get(account.actualAccountId);
    const cardNumber = cardNumbers.get(account.truelayerAccountId);

    // A missing lookup means the account is no longer returned by TrueLayer, or
    // the Actual account has been closed. Neither is this command's business to
    // resolve, so say so and leave the existing label alone.
    if (!provider) {
      logger.warn(`[${account.name}] Not returned by TrueLayer — leaving labels as they are`);
    }
    if (!actualName) {
      logger.warn(`[${account.name}] No open Actual account ${account.actualAccountId} — leaving labels as they are`);
    }

    if (provider && account.provider !== provider) {
      logger.info(`[${account.name}] Provider: ${account.provider ?? '(none)'} → ${provider}`);
      account.provider = provider;
      changed++;
    }
    if (name && account.name !== name) {
      logger.info(`[${account.name}] Name: ${account.name} → ${name}`);
      account.name = name;
      changed++;
    }
    if (cardNumber && account.partialCardNumber !== cardNumber) {
      logger.info(`[${account.name}] Card number: ${account.partialCardNumber ?? '(none)'} → ${cardNumber}`);
      account.partialCardNumber = cardNumber;
      changed++;
    }
    if (actualName && account.actualAccountName !== actualName) {
      logger.info(`[${account.name}] Actual account: ${account.actualAccountName ?? '(none)'} → ${actualName}`);
      account.actualAccountName = actualName;
      changed++;
    }
  }

  if (changed === 0) {
    logger.info('Every label is already up to date — nothing written');
    return;
  }

  await saveConfig(config);
  logger.info(`Relabel complete — ${changed} label(s) updated`);
}

main().catch((err) => {
  logger.error('Relabel failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
