import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig } from '../config.js';
import { loadConnection, refreshConnectionIfNeeded } from '../auth/tokens.js';
import {
  fetchTransactions,
  fetchCardTransactions,
  fetchBalance,
  fetchCardBalance,
  type TrueLayerBalance,
} from '../clients/truelayer.js';
import {
  initActual,
  shutdownActual,
  importToActual,
  getActualAccountBalance,
} from '../clients/actual.js';
import { mapTransaction } from '../mapper.js';
import { logger } from '../logger.js';
import type { Account } from '../config.js';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Balance validation
// ---------------------------------------------------------------------------

const DRIFT_THRESHOLD_PENCE = 100;

async function validateBalance(accessToken: string, account: Account): Promise<void> {
  let tlBalance: TrueLayerBalance;
  try {
    tlBalance = account.accountKind === 'card'
      ? await fetchCardBalance(accessToken, account.truelayerAccountId)
      : await fetchBalance(accessToken, account.truelayerAccountId);
  } catch (err) {
    logger.warn(
      `[${account.name}] Could not fetch balance for validation:`,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  let actualBalancePence: number;
  try {
    actualBalancePence = await getActualAccountBalance(account.actualAccountId);
  } catch (err) {
    logger.warn(
      `[${account.name}] Could not fetch Actual balance for validation:`,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  const tlCurrentPence = Math.round(tlBalance.current * 100);
  const drift = Math.abs(tlCurrentPence - actualBalancePence);

  if (drift > DRIFT_THRESHOLD_PENCE) {
    logger.warn(
      `[${account.name}] Balance drift! ` +
        `TrueLayer: £${tlBalance.current.toFixed(2)}, ` +
        `Actual: £${(actualBalancePence / 100).toFixed(2)}, ` +
        `Drift: £${(drift / 100).toFixed(2)}`
    );
  } else {
    logger.debug(`[${account.name}] Balance consistent (drift: ${drift}p)`);
  }
}

// ---------------------------------------------------------------------------
// Main sync flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('Starting truelayer2actual sync...');

  const cacheDir = path.join(process.cwd(), 'data', 'actual-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const config = await loadConfig();

  if (config.accounts.length === 0) {
    logger.warn('No accounts configured. Run "npm run setup" to pair accounts.');
    process.exit(0);
  }

  // Refresh tokens per connection (one token covers one bank)
  const connectionTokens = new Map<string, string>();
  const connectionIds = [...new Set(config.accounts.map((a) => a.connectionId))];

  for (const connectionId of connectionIds) {
    const tokens = loadConnection(connectionId);
    const accessToken = await refreshConnectionIfNeeded(connectionId, tokens);
    connectionTokens.set(connectionId, accessToken);
  }

  await initActual();

  try {
    for (const account of config.accounts) {
      const accessToken = connectionTokens.get(account.connectionId)!;

      const lookback = Number(process.env.SYNC_DAYS_LOOKBACK ?? '7');
      const from = account.lastSyncedAt
        ? account.lastSyncedAt.split('T')[0]
        : daysAgo(lookback);
      const to = daysAgo(-1);

      logger.info(`[${account.name}] Syncing from ${from} to ${to}...`);

      const txns = account.accountKind === 'card'
        ? await fetchCardTransactions(accessToken, account.truelayerAccountId, from, to)
        : await fetchTransactions(accessToken, account.truelayerAccountId, from, to);
      logger.info(`[${account.name}] Fetched ${txns.length} transaction(s)`);

      const isCard = account.accountKind === 'card';
      const mapped = txns.map((t) => mapTransaction(t, isCard));
      const result = await importToActual(account.actualAccountId, mapped);

      logger.info(`[${account.name}] +${result.added.length} added, ${result.updated.length} updated`);

      if (result.errors && result.errors.length > 0) {
        throw new Error(`[${account.name}] Import errors: ${JSON.stringify(result.errors)}`);
      }

      await validateBalance(accessToken, account);
      account.lastSyncedAt = new Date().toISOString();
    }
  } finally {
    await shutdownActual();
  }

  await saveConfig(config);
  logger.info('Sync complete');
}

async function loop(): Promise<void> {
  const intervalHours = Number(process.env.SYNC_INTERVAL_HOURS ?? '0');

  if (intervalHours <= 0) {
    // One-shot mode (for external schedulers like Synology Task Scheduler)
    await main();
    return;
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  logger.info(`Running in loop mode — syncing every ${intervalHours} hour(s)`);

  while (true) {
    await main().catch((err) => {
      logger.error('Sync failed:', err instanceof Error ? err.message : String(err));
    });
    logger.info(`Next sync in ${intervalHours} hour(s)...`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

loop().catch((err) => {
  logger.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
