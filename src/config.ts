import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from './logger.js';
import { atomicWriteFile } from './util/fs.js';
import { withStateLock } from './util/lock.js';

const AccountSchema = z.object({
  name: z.string(),
  connectionId: z.string(),
  accountKind: z.enum(['account', 'card']).default('account'),
  truelayerAccountId: z.string(),
  actualAccountId: z.string(),
  currency: z.string().default('GBP'),
  lastSyncedAt: z.string().optional(),
});

const ConfigSchema = z.object({
  accounts: z.array(AccountSchema),
  createdAt: z.string(),
});

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

  logger.debug(`Loaded config with ${result.data.accounts.length} account(s)`);
  return result.data;
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
