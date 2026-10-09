import 'dotenv/config';
import { pathToFileURL } from 'url';
import { loadConfig, updateConfig, reauthWarnDays } from '../config.js';
import {
  loadConnection,
  refreshConnectionIfNeeded,
  getConnection,
  markConnectionHealthy,
  markConnectionNeedsReauth,
  ReauthRequiredError,
} from '../auth/tokens.js';
import {
  fetchTransactions,
  fetchCardTransactions,
  fetchBalance,
  fetchCardBalance,
  getMe,
  ConsentExpiredError,
  type TrueLayerBalance,
  type TrueLayerMe,
} from '../clients/truelayer.js';
import {
  withActual,
  shutdownActual,
  importToActual,
  getActualAccountBalance,
} from '../clients/actual.js';
import { mapTransaction } from '../mapper.js';
import { notifyConnection } from '../notify.js';
import { createMutex } from '../util/lock.js';
import { describeError } from '../util/errors.js';
import { logger } from '../logger.js';
import type { Account } from '../config.js';

/** Prevents two full syncs from overlapping (token rotation, double import). */
const withSyncLock = createMutex();

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

export function dashboardUrl(): string | undefined {
  return process.env.DASHBOARD_URL;
}

function connectionLabel(connectionId: string): string {
  return getConnection(connectionId)?.providerDisplayName ?? connectionId;
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
      describeError(err)
    );
    return;
  }

  let actualBalancePence: number;
  try {
    actualBalancePence = await getActualAccountBalance(account.actualAccountId);
  } catch (err) {
    logger.warn(
      `[${account.name}] Could not fetch Actual balance for validation:`,
      describeError(err)
    );
    return;
  }

  // TrueLayer reports card balances as positive (amount owed), but Actual stores
  // credit card accounts as negative — negate so both are on the same scale.
  const tlCurrentPence = Math.round(tlBalance.current * 100) * (account.accountKind === 'card' ? -1 : 1);
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
// Per-connection token resolution (isolated so one dead bank can't abort sync)
// ---------------------------------------------------------------------------

export interface ConnectionTokenResolution {
  accessTokens: Map<string, string>;
  skipped: { connectionId: string; reason: string }[];
  errors: { connectionId: string; reason: string }[];
}

export interface ResolveConnectionTokensDeps {
  loadConnection?: typeof loadConnection;
  refreshConnectionIfNeeded?: typeof refreshConnectionIfNeeded;
}

export async function resolveConnectionTokens(
  connectionIds: string[],
  deps: ResolveConnectionTokensDeps = {}
): Promise<ConnectionTokenResolution> {
  const load = deps.loadConnection ?? loadConnection;
  const refresh = deps.refreshConnectionIfNeeded ?? refreshConnectionIfNeeded;

  const accessTokens = new Map<string, string>();
  const skipped: ConnectionTokenResolution['skipped'] = [];
  const errors: ConnectionTokenResolution['errors'] = [];

  for (const connectionId of connectionIds) {
    try {
      const tokens = load(connectionId);
      const accessToken = await refresh(connectionId, tokens);
      accessTokens.set(connectionId, accessToken);
    } catch (err) {
      const reason = describeError(err);
      if (err instanceof ReauthRequiredError) {
        logger.warn(`[${connectionId}] ${reason} — skipping its accounts this run.`);
        skipped.push({ connectionId, reason });
        await notifyConnection(connectionId, 'refresh_token_invalid', {
          title: `Reconnect ${connectionLabel(connectionId)}`,
          message: 'TrueLayer access for this bank has expired. Open the dashboard to reconnect.',
          url: dashboardUrl(),
          priority: 'high',
        });
      } else {
        logger.error(`[${connectionId}] Failed to prepare connection:`, reason);
        errors.push({ connectionId, reason });
      }
    }
  }

  return { accessTokens, skipped, errors };
}

// ---------------------------------------------------------------------------
// Connection metadata (/me) + consent expiry visibility
// ---------------------------------------------------------------------------

async function refreshConnectionMetadata(
  connectionId: string,
  accessToken: string
): Promise<void> {
  let me: TrueLayerMe;
  try {
    me = await getMe(accessToken);
  } catch (err) {
    if (err instanceof ConsentExpiredError) {
      logger.warn(`[${connectionId}] TrueLayer consent has expired — re-auth required.`);
      await markConnectionNeedsReauth(connectionId, 'consent_expired');
      await notifyConnection(connectionId, 'consent_expired', {
        title: `Reconnect ${connectionLabel(connectionId)}`,
        message: 'TrueLayer consent has expired. Open the dashboard to reconnect.',
        url: dashboardUrl(),
        priority: 'high',
      });
    } else {
      logger.debug(
        `[${connectionId}] Could not refresh connection metadata:`,
        describeError(err)
      );
    }
    return;
  }

  await markConnectionHealthy(connectionId, {
    providerId: me.provider?.provider_id,
    providerDisplayName: me.provider?.display_name,
    consentExpiresAt: me.consent_expires_at,
    consentStatus: me.consent_status,
  });

  if (me.consent_expires_at) {
    const msLeft = Date.parse(me.consent_expires_at) - Date.now();
    const daysLeft = Math.floor(msLeft / 86_400_000);
    if (msLeft <= reauthWarnDays() * 86_400_000) {
      const label = connectionLabel(connectionId);
      logger.warn(
        `[${connectionId}] Consent expires in ${daysLeft} day(s) (${me.consent_expires_at}).`
      );
      await notifyConnection(connectionId, 'consent_expiring', {
        title: `TrueLayer consent expiring for ${label}`,
        message: `Reconnect ${label} within ${daysLeft} day(s) to avoid a sync outage.`,
        url: dashboardUrl(),
        priority: 'default',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main sync flow
// ---------------------------------------------------------------------------

export interface SyncSummary {
  synced: string[];
  skipped: { connectionId: string; reason: string }[];
  errors: { connectionId?: string; account?: string; reason: string }[];
}

/**
 * Resolves when the most recent runSync call finishes (or immediately when
 * none has started). Lets shutdown wait for an in-flight sync — scheduled or
 * manual — so state files are never cut off mid-write.
 */
let lastRun: Promise<unknown> = Promise.resolve();

export function lastSyncSettled(): Promise<unknown> {
  return lastRun;
}

export async function runSync(): Promise<SyncSummary> {
  const run = withSyncLock(() => runSyncInternal());
  lastRun = run.catch(() => undefined);
  return run;
}

async function runSyncInternal(): Promise<SyncSummary> {
  logger.info('Starting truelayer2actual sync...');

  const summary: SyncSummary = { synced: [], skipped: [], errors: [] };
  const config = await loadConfig();

  if (config.accounts.length === 0) {
    logger.warn('No accounts configured. Run "npm run setup" to pair accounts.');
    return summary;
  }

  const connectionIds = [...new Set(config.accounts.map((a) => a.connectionId))];
  const { accessTokens, skipped, errors } = await resolveConnectionTokens(connectionIds);
  summary.skipped.push(...skipped);
  summary.errors.push(...errors);

  // Record sync timestamps by TrueLayer account id and persist them with a
  // locked read-merge-write afterwards, so a concurrent reauth/pairing that
  // changed connection ids isn't clobbered by a stale in-memory snapshot.
  const lastSyncedAt = new Map<string, string>();

  await withActual(async () => {
    for (const account of config.accounts) {
      const accessToken = accessTokens.get(account.connectionId);
      if (!accessToken) continue;

      try {
        const lookback = Number(process.env.SYNC_DAYS_LOOKBACK ?? '7');
        const to = today();
        const lastSyncDate = account.lastSyncedAt
          ? account.lastSyncedAt.split('T')[0]
          : daysAgo(lookback);
        // Always look back at least `lookback` days so transactions that were pending
        // at last sync but have since settled are not missed.
        const floor = daysAgo(lookback);
        const from = lastSyncDate < floor ? lastSyncDate : floor;

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
          throw new Error(`Import errors: ${JSON.stringify(result.errors)}`);
        }

        await validateBalance(accessToken, account);
        lastSyncedAt.set(account.truelayerAccountId, new Date().toISOString());
        summary.synced.push(account.name);
      } catch (err) {
        const reason = describeError(err);
        logger.error(`[${account.name}] Sync failed:`, reason);
        summary.errors.push({
          connectionId: account.connectionId,
          account: account.name,
          reason,
        });
      }
    }
  });

  if (lastSyncedAt.size > 0) {
    await updateConfig((cfg) => {
      for (const account of cfg.accounts) {
        const ts = lastSyncedAt.get(account.truelayerAccountId);
        if (ts) account.lastSyncedAt = ts;
      }
    });
  }

  // Best-effort metadata refresh — never fail the run over this.
  for (const [connectionId, accessToken] of accessTokens) {
    await refreshConnectionMetadata(connectionId, accessToken);
  }

  logger.info(
    `Sync complete — ${summary.synced.length} account(s) synced, ` +
      `${summary.skipped.length} connection(s) need re-auth, ${summary.errors.length} error(s)`
  );
  return summary;
}

async function main(): Promise<void> {
  try {
    await runSync();
  } finally {
    await shutdownActual();
  }
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await main().catch((err) => {
      logger.error('Sync failed:', describeError(err));
    });
    logger.info(`Next sync in ${intervalHours} hour(s)...`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  loop().catch((err) => {
    logger.error('Fatal error:', describeError(err));
    process.exit(1);
  });
}
