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
  withBudget,
  shutdownActual,
  importToActual,
  getActualAccountBalance,
  getActualImportedIds,
  setActualImportedId,
} from '../clients/actual.js';
import { mapTransaction, planImportedIdMigrations } from '../mapper.js';
import { notifyConnection } from '../notify.js';
import { createMutex } from '../util/lock.js';
import { describeError } from '../util/errors.js';
import { logger } from '../logger.js';
import type { Account, Budget, Config } from '../config.js';

/** Prevents two full syncs from overlapping (token rotation, double import). */
export const withSyncLock = createMutex();

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Move rows already in Actual under TrueLayer's old transaction_id onto the
 * stable ID, so the import below matches them instead of adding duplicates.
 * Best-effort: on failure, log and import anyway.
 */
async function migrateImportedIds(
  account: Account,
  txns: Parameters<typeof planImportedIdMigrations>[0],
  from: string,
  to: string
): Promise<void> {
  try {
    // Widen the window a little: an amended transaction can shift date.
    const existing = await getActualImportedIds(
      account.actualAccountId,
      shiftDate(from, -7),
      shiftDate(to, 7)
    );
    const plan = planImportedIdMigrations(txns, existing);
    for (const m of plan) await setActualImportedId(m.id, m.imported_id);
    if (plan.length > 0) {
      logger.info(
        `[${account.name}] Moved ${plan.length} existing transaction(s) to TrueLayer's stable ID`
      );
    }
  } catch (err) {
    logger.warn(
      `[${account.name}] Could not migrate imported IDs (import continues):`,
      describeError(err)
    );
  }
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

export function dashboardUrl(): string | undefined {
  return process.env.DASHBOARD_URL;
}

/**
 * Parse SYNC_INTERVAL_HOURS. Missing/blank means one-shot mode (0). An invalid
 * value also falls back to one-shot with a warning, so a typo can never spin
 * the scheduler on a NaN delay.
 */
export function resolveIntervalHours(): number {
  const raw = process.env.SYNC_INTERVAL_HOURS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(`Ignoring invalid SYNC_INTERVAL_HOURS "${raw}" — running one-shot.`);
    return 0;
  }
  return n;
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

async function syncAccount(
  account: Account,
  accessToken: string,
  lastSyncedAt: Map<string, string>,
  summary: SyncSummary
): Promise<void> {
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

    await migrateImportedIds(account, txns, from, to);

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

export interface BudgetGroup {
  budget: Budget;
  /** Every account mapped to the budget. */
  accounts: Account[];
  /** Accounts whose connection has a usable access token. */
  ready: Account[];
}

export interface BudgetGrouping {
  /** Known budgets with at least one ready account (the ones to sync). */
  groups: BudgetGroup[];
  /** Budgets skipped because none of their banks are usable this run. */
  skipped: BudgetGroup[];
  /** Accounts that reference a budget id missing from the config. */
  errors: { connectionId: string; account: string; reason: string }[];
}

/**
 * Pure planning step of a sync: bucket accounts by budget, flag accounts whose
 * budget no longer exists, and drop budgets with no usable connection so the
 * (slow) budget download is skipped.
 */
export function groupAccountsByBudget(
  config: Pick<Config, 'budgets' | 'accounts'>,
  accessTokens: { has(connectionId: string): boolean }
): BudgetGrouping {
  const budgetById = new Map<string, Budget>(config.budgets.map((b) => [b.id, b]));
  const accountsByBudget = new Map<string, Account[]>();
  for (const account of config.accounts) {
    const list = accountsByBudget.get(account.budgetId) ?? [];
    list.push(account);
    accountsByBudget.set(account.budgetId, list);
  }

  const result: BudgetGrouping = { groups: [], skipped: [], errors: [] };
  for (const [budgetId, accounts] of accountsByBudget) {
    const budget = budgetById.get(budgetId);
    if (!budget) {
      for (const account of accounts) {
        result.errors.push({
          connectionId: account.connectionId,
          account: account.name,
          reason: `Unknown budget "${budgetId}" — run "npm run setup" to reconfigure.`,
        });
      }
      continue;
    }

    const ready = accounts.filter((a) => accessTokens.has(a.connectionId));
    const group = { budget, accounts, ready };
    if (ready.length === 0) result.skipped.push(group);
    else result.groups.push(group);
  }
  return result;
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

  // Group accounts by Actual budget and sync each budget in turn, switching the
  // Active Budget client to the right budget before touching its accounts.
  const grouping = groupAccountsByBudget(config, accessTokens);
  summary.errors.push(...grouping.errors);

  for (const { budget, accounts, ready } of grouping.groups) {
    try {
      await withBudget(budget, async () => {
        for (const account of ready) {
          await syncAccount(account, accessTokens.get(account.connectionId)!, lastSyncedAt, summary);
        }
      });
    } catch (err) {
      // A budget that can't be downloaded shouldn't abort the other budgets.
      const reason = describeError(err);
      logger.error(`[budget ${budget.name}] Failed to switch budget:`, reason);
      for (const account of accounts) {
        summary.errors.push({
          connectionId: account.connectionId,
          account: account.name,
          reason,
        });
      }
    }
  }

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
  const intervalHours = resolveIntervalHours();

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
