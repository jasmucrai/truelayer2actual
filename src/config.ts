import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { logger } from './logger.js';
import { atomicWriteFile } from './util/fs.js';
import { withStateLock } from './util/lock.js';

/** Identifier used for the single legacy budget defined by env vars. */
export const DEFAULT_BUDGET_ID = 'default';

const BudgetSchema = z.object({
  id: z.string(),
  name: z.string(),
  syncId: z.string(),
  encryptionPassword: z.string().optional(),
});

const AccountSchema = z.object({
  name: z.string(),
  connectionId: z.string(),
  budgetId: z.string().default(DEFAULT_BUDGET_ID),
  accountKind: z.enum(['account', 'card']).default('account'),
  truelayerAccountId: z.string(),
  actualAccountId: z.string(),
  currency: z.string().default('GBP'),
  lastSyncedAt: z.string().optional(),
});

const ConfigSchema = z.object({
  budgets: z.array(BudgetSchema).default([]),
  accounts: z.array(AccountSchema),
  createdAt: z.string(),
});

export type Budget = z.infer<typeof BudgetSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// Resolved lazily so tests can point the path at a temp directory before the
// first call (main code resolves on first use too).
let configPath: string | null = null;

/** Override where config.json is read/written (used by tests). */
export function setConfigPathForTests(p: string): void {
  configPath = p;
}

function configPathResolve(): string {
  return (configPath ??= path.join(process.cwd(), 'data', 'config.json'));
}

/** Consent-expiry warning threshold in days (REAUTH_WARN_DAYS, default 14). */
export function reauthWarnDays(): number {
  const n = Number(process.env.REAUTH_WARN_DAYS ?? '14');
  return Number.isFinite(n) && n >= 0 ? n : 14;
}

export const DEFAULT_SYNC_INTERVAL_HOURS = 6;
// setInterval overflows (and fires almost immediately) above 2^31-1 ms ≈ 596 h.
export const MAX_SYNC_INTERVAL_HOURS = Math.floor((2 ** 31 - 1) / 3_600_000);

/**
 * Scheduler interval for the always-on `serve` process (SYNC_INTERVAL_HOURS).
 *
 * `0` means "one-shot" only for `node dist/commands/sync.js`; the always-on
 * process ignores it and uses the default rather than silently stopping
 * scheduled syncs. Invalid or out-of-range values fall back with a warning.
 */
export function syncIntervalHours(raw = process.env.SYNC_INTERVAL_HOURS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SYNC_INTERVAL_HOURS;
  const n = Number(raw);
  if (n === 0) {
    logger.warn(
      'SYNC_INTERVAL_HOURS=0 only means one-shot for `node dist/commands/sync.js`. ' +
        `The always-on dashboard ignores it and syncs every ${DEFAULT_SYNC_INTERVAL_HOURS} hour(s); ` +
        'set a positive value to change the interval.'
    );
    return DEFAULT_SYNC_INTERVAL_HOURS;
  }
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(
      `Invalid SYNC_INTERVAL_HOURS="${raw}" — using ${DEFAULT_SYNC_INTERVAL_HOURS} hour(s).`
    );
    return DEFAULT_SYNC_INTERVAL_HOURS;
  }
  if (n > MAX_SYNC_INTERVAL_HOURS) {
    logger.warn(
      `SYNC_INTERVAL_HOURS=${raw} exceeds the timer limit — using ${MAX_SYNC_INTERVAL_HOURS} hour(s).`
    );
    return MAX_SYNC_INTERVAL_HOURS;
  }
  return n;
}

/**
 * Build the single "default" budget from the legacy environment variables.
 * Returns `null` when no legacy sync id is configured.
 */
export function budgetFromEnv(): Budget | null {
  const syncId = process.env.ACTUAL_SYNC_ID;
  if (!syncId) return null;
  return {
    id: DEFAULT_BUDGET_ID,
    name: 'Default',
    syncId,
    encryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD || undefined,
  };
}

export function generateBudgetId(): string {
  return `budget_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Thrown when a budget would reuse the sync id of another configured budget. */
export class DuplicateSyncIdError extends Error {
  constructor(
    public readonly syncId: string,
    public readonly existing: Budget
  ) {
    super(
      `Sync ID ${syncId} is already used by budget "${existing.name}". ` +
        'Each Actual budget has its own sync ID (Actual → Settings → Advanced).'
    );
    this.name = 'DuplicateSyncIdError';
  }
}

/**
 * Find a budget other than `excludeId` that already uses `syncId`. Two budgets
 * pointing at the same sync id are the same Actual file, so they would list
 * identical accounts under different names.
 */
export function findBudgetBySyncId(
  budgets: Budget[],
  syncId: string,
  excludeId?: string
): Budget | undefined {
  return budgets.find((b) => b.syncId === syncId && b.id !== excludeId);
}

/** Group budgets that share a sync id; only groups of two or more are returned. */
export function duplicateSyncIdGroups(budgets: Budget[]): Budget[][] {
  const bySyncId = new Map<string, Budget[]>();
  for (const budget of budgets) {
    const group = bySyncId.get(budget.syncId) ?? [];
    group.push(budget);
    bySyncId.set(budget.syncId, group);
  }
  return [...bySyncId.values()].filter((group) => group.length > 1);
}

/**
 * Normalise a parsed config so legacy files keep working: seed a "default"
 * budget from env vars when none are defined, and make sure any account that
 * still references the default budget id has a matching budget to point at.
 */
function normalizeBudgets(data: Config): Config {
  let budgets = data.budgets;

  if (budgets.length === 0) {
    const envBudget = budgetFromEnv();
    if (envBudget) budgets = [envBudget];
  }

  const referencesDefault = data.accounts.some((a) => a.budgetId === DEFAULT_BUDGET_ID);
  if (referencesDefault && !budgets.some((b) => b.id === DEFAULT_BUDGET_ID)) {
    const envBudget = budgetFromEnv();
    if (envBudget) budgets = [envBudget, ...budgets];
  }

  return budgets === data.budgets ? data : { ...data, budgets };
}

export async function loadConfig(): Promise<Config> {
  if (!fs.existsSync(configPathResolve())) {
    throw new Error(
      `Config file not found at ${configPathResolve()}. ` +
        'Please run "npm run setup" first to create an account mapping.'
    );
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(configPathResolve(), 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to read or parse config file at ${configPathResolve()}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid config file at ${configPathResolve()}: ${result.error.message}`
    );
  }

  const config = normalizeBudgets(result.data);
  logger.debug(
    `Loaded config with ${config.accounts.length} account(s) across ${config.budgets.length} budget(s)`
  );
  return config;
}

export async function saveConfig(config: Config): Promise<void> {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Cannot save invalid config: ${result.error.message}`);
  }

  // Bank account names and TrueLayer account ids — treat as sensitive
  // (tokens.json is 0600; config carries no secrets but is personal data).
  atomicWriteFile(configPathResolve(), JSON.stringify(result.data, null, 2) + '\n', { mode: 0o600 });
  logger.debug(`Saved config to ${configPathResolve()}`);
}

/**
 * Merge incoming account pairings into an existing list, keyed by
 * `truelayerAccountId`. Existing entries keep any fields not overwritten
 * (notably `lastSyncedAt`) so re-auth never resets sync history.
 */
export function mergeAccounts(existing: Account[], incoming: Account[]): Account[] {
  const merged: Account[] = [...existing];
  for (const account of incoming) {
    const idx = merged.findIndex(
      (a) => a.truelayerAccountId === account.truelayerAccountId
    );
    if (idx !== -1) {
      merged[idx] = { ...merged[idx], ...account };
    } else {
      merged.push(account);
    }
  }
  return merged;
}

/**
 * Load config.json only if it exists, returning `null` otherwise. A file that
 * exists but cannot be read/parsed still throws — callers must never treat a
 * corrupt config as an empty one, or they risk wiping other connections'
 * mappings and tokens.
 */
export async function loadConfigIfExists(): Promise<Config | null> {
  if (!fs.existsSync(configPathResolve())) return null;
  return loadConfig();
}

/**
 * Read-modify-write `config.json` under the state lock, re-reading the file
 * inside the critical section. Use this for partial updates (e.g. recording
 * `lastSyncedAt`) so a concurrent writer's changes are not clobbered.
 */
export function updateConfig(mutator: (config: Config) => void): Promise<Config> {
  return withStateLock(async () => {
    const config = await loadConfig();
    mutator(config);
    await saveConfig(config);
    return config;
  });
}

/**
 * Remove every account mapping that belongs to a connection (used when a
 * connection is deleted). Returns the remaining accounts. Does not throw when
 * no config exists yet.
 */
export async function removeAccountsForConnection(connectionId: string): Promise<Account[]> {
  return withStateLock(async () => {
    let config: Config;
    try {
      config = await loadConfig();
    } catch {
      return [];
    }

    const remaining = config.accounts.filter((a) => a.connectionId !== connectionId);
    if (remaining.length !== config.accounts.length) {
      config.accounts = remaining;
      await saveConfig(config);
      logger.debug(`Removed accounts for connection ${connectionId} from config.json`);
    }
    return remaining;
  });
}

/**
 * Return the configured budgets, falling back to the env-defined default
 * budget when no config exists yet. Used by the web dashboard pairing flow.
 */
export async function listBudgets(): Promise<Budget[]> {
  try {
    const config = await loadConfig();
    if (config.budgets.length > 0) return config.budgets;
  } catch {
    // No config yet — fall through to the env fallback.
  }
  const envBudget = budgetFromEnv();
  return envBudget ? [envBudget] : [];
}

/**
 * Add or update a budget, creating the config file on first use. Rejects a
 * sync id that another budget already uses (see {@link DuplicateSyncIdError}).
 */
export async function addBudget(budget: Budget): Promise<Budget[]> {
  return withStateLock(async () => {
    // Only a missing file starts fresh; a corrupt config must throw rather
    // than be overwritten (which would wipe the account mappings).
    const config: Config = (await loadConfigIfExists()) ?? {
      budgets: [],
      accounts: [],
      createdAt: new Date().toISOString(),
    };

    const clash = findBudgetBySyncId(config.budgets, budget.syncId, budget.id);
    if (clash) throw new DuplicateSyncIdError(budget.syncId, clash);

    const idx = config.budgets.findIndex((b) => b.id === budget.id);
    if (idx === -1) config.budgets.push(budget);
    else config.budgets[idx] = budget;

    await saveConfig(config);
    return config.budgets;
  });
}

export interface ReconcileOptions {
  /** The connection id the fetched accounts now belong to. */
  newConnectionId: string;
  /** The previous connection id whose accounts should be repointed. */
  remapFrom?: string;
  /** TrueLayer account ids returned by the latest consent. */
  fetchedIds: Set<string>;
}

export interface ReconcileResult {
  accounts: Account[];
  changed: boolean;
  /** Previously mapped accounts that the consent did not return. */
  missing: Account[];
}

/**
 * Repoint existing mappings at a (possibly new) connection id after re-auth,
 * without touching pairings or `lastSyncedAt`. Pure helper so the risky part
 * of the callback is unit-testable.
 */
export function reconcileConfigAccounts(
  accounts: Account[],
  options: ReconcileOptions
): ReconcileResult {
  const { newConnectionId, remapFrom, fetchedIds } = options;
  const missing: Account[] = [];
  let changed = false;

  const next = accounts.map((account) => {
    const wasOnRemap = remapFrom !== undefined && account.connectionId === remapFrom;
    const isFetched = fetchedIds.has(account.truelayerAccountId);

    if (wasOnRemap && !isFetched) missing.push(account);

    if ((wasOnRemap || isFetched) && account.connectionId !== newConnectionId) {
      changed = true;
      return { ...account, connectionId: newConnectionId };
    }
    return account;
  });

  return { accounts: next, changed, missing };
}
