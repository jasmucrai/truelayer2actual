import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  setConfigPathForTests,
  loadConfig,
  listBudgets,
  addBudget,
  budgetFromEnv,

  mergeAccounts,
  reconcileConfigAccounts,
  applyPairingChanges,
  findBudgetBySyncId,
  duplicateSyncIdGroups,
  DuplicateSyncIdError,
  type Account,
  type Budget,
} from '../src/config.js';

function account(overrides: Partial<Account> = {}): Account {
  return {
    name: 'Acct',
    connectionId: 'old',
    budgetId: 'default',
    accountKind: 'account',
    truelayerAccountId: 'tl-1',
    actualAccountId: 'actual-1',
    currency: 'GBP',
    ...overrides,
  };
}

describe('mergeAccounts', () => {
  it('updates the pairing but preserves lastSyncedAt', () => {
    const existing = [account({ lastSyncedAt: '2026-01-01T00:00:00.000Z' })];
    const incoming = [account({ actualAccountId: 'actual-2' })];

    const merged = mergeAccounts(existing, incoming);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].actualAccountId, 'actual-2');
    assert.equal(merged[0].lastSyncedAt, '2026-01-01T00:00:00.000Z');
  });

  it('carries the incoming budgetId into a merged account', () => {
    const existing = [account({ budgetId: 'default' })];
    const incoming = [account({ budgetId: 'budget_123' })];

    const merged = mergeAccounts(existing, incoming);

    assert.equal(merged[0].budgetId, 'budget_123');
  });

  it('appends accounts that are not already mapped', () => {
    const existing = [account()];
    const incoming = [account({ truelayerAccountId: 'tl-2', actualAccountId: 'actual-2' })];

    const merged = mergeAccounts(existing, incoming);

    assert.equal(merged.length, 2);
    assert.equal(merged[1].truelayerAccountId, 'tl-2');
  });
});

describe('reconcileConfigAccounts', () => {
  it('repoints accounts from the previous connection, preserving everything else', () => {
    const accounts = [
      account({ connectionId: 'old', lastSyncedAt: '2026-01-01T00:00:00.000Z' }),
    ];

    const result = reconcileConfigAccounts(accounts, {
      newConnectionId: 'new',
      remapFrom: 'old',
      fetchedIds: new Set(['tl-1']),
    });

    assert.equal(result.changed, true);
    assert.equal(result.accounts[0].connectionId, 'new');
    assert.equal(result.accounts[0].lastSyncedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(result.accounts[0].actualAccountId, 'actual-1');
    assert.deepEqual(result.missing, []);
  });

  it('reports accounts not returned by consent but keeps and repoints them', () => {
    const accounts = [
      account({ connectionId: 'old', truelayerAccountId: 'tl-gone' }),
    ];

    const result = reconcileConfigAccounts(accounts, {
      newConnectionId: 'new',
      remapFrom: 'old',
      fetchedIds: new Set(),
    });

    assert.equal(result.missing.length, 1);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].connectionId, 'new');
  });

  it('leaves other banks untouched when adding a brand-new connection', () => {
    const accounts = [
      account({ connectionId: 'other', truelayerAccountId: 'tl-other' }),
    ];

    const result = reconcileConfigAccounts(accounts, {
      newConnectionId: 'new',
      fetchedIds: new Set(['tl-new']),
    });

    assert.equal(result.changed, false);
    assert.equal(result.accounts[0].connectionId, 'other');
    assert.deepEqual(result.missing, []);
  });
});

describe('applyPairingChanges', () => {
  it('re-points a mapping at a new account and budget', () => {
    const accounts = [account({ connectionId: 'conn', budgetId: 'default', actualAccountId: 'old' })];

    const result = applyPairingChanges(accounts, 'conn', {
      'tl-1': { budgetId: 'budget_1', actualAccountId: 'new' },
    });

    assert.equal(result.changed, 1);
    assert.equal(result.removed, 0);
    assert.equal(result.accounts[0].budgetId, 'budget_1');
    assert.equal(result.accounts[0].actualAccountId, 'new');
  });

  it('removes a mapping when the account id is blank', () => {
    const accounts = [
      account({ connectionId: 'conn', truelayerAccountId: 'tl-1' }),
      account({ connectionId: 'conn', truelayerAccountId: 'tl-2' }),
    ];

    const result = applyPairingChanges(accounts, 'conn', {
      'tl-1': { budgetId: 'default', actualAccountId: '' },
    });

    assert.equal(result.removed, 1);
    assert.equal(result.changed, 0);
    assert.deepEqual(
      result.accounts.map((a) => a.truelayerAccountId),
      ['tl-2']
    );
  });

  it('leaves another connection untouched even when it shares an account id', () => {
    const accounts = [
      account({ connectionId: 'conn', truelayerAccountId: 'tl-1', actualAccountId: 'old' }),
      account({ connectionId: 'other', truelayerAccountId: 'tl-1', actualAccountId: 'other-old' }),
    ];

    const result = applyPairingChanges(accounts, 'conn', {
      'tl-1': { budgetId: 'default', actualAccountId: 'new' },
    });

    assert.equal(result.changed, 1);
    assert.equal(result.accounts[1].actualAccountId, 'other-old');
  });

  it('does not count an unchanged selection as a change', () => {
    const accounts = [account({ connectionId: 'conn', budgetId: 'default', actualAccountId: 'same' })];

    const result = applyPairingChanges(accounts, 'conn', {
      'tl-1': { budgetId: 'default', actualAccountId: 'same' },
    });

    assert.equal(result.changed, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.accounts[0].actualAccountId, 'same');
  });

  it('preserves fields like lastSyncedAt when re-pointing', () => {
    const accounts = [
      account({ connectionId: 'conn', lastSyncedAt: '2026-01-01T00:00:00.000Z' }),
    ];

    const result = applyPairingChanges(accounts, 'conn', {
      'tl-1': { budgetId: 'budget_1', actualAccountId: 'new' },
    });

    assert.equal(result.accounts[0].lastSyncedAt, '2026-01-01T00:00:00.000Z');
  });

  it('ignores changes for unknown account ids and inherited object keys', () => {
    const accounts = [account({ connectionId: 'conn', truelayerAccountId: 'constructor' })];

    const result = applyPairingChanges(accounts, 'conn', {
      'tl-unknown': { budgetId: 'default', actualAccountId: 'x' },
    });

    assert.equal(result.changed, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.accounts.length, 1);
  });

  it('applies several changes and removals in one pass without mutating the input', () => {
    const accounts = [
      account({ connectionId: 'conn', truelayerAccountId: 'tl-1', actualAccountId: 'a' }),
      account({ connectionId: 'conn', truelayerAccountId: 'tl-2', actualAccountId: 'b' }),
      account({ connectionId: 'conn', truelayerAccountId: 'tl-3', actualAccountId: 'c' }),
    ];
    const snapshot = JSON.stringify(accounts);

    const result = applyPairingChanges(accounts, 'conn', {
      'tl-1': { budgetId: 'budget_1', actualAccountId: 'z' },
      'tl-2': { budgetId: 'default', actualAccountId: '  ' },
    });

    assert.equal(result.changed, 1);
    assert.equal(result.removed, 1);
    assert.deepEqual(result.accounts.map((a) => a.truelayerAccountId), ['tl-1', 'tl-3']);
    assert.equal(JSON.stringify(accounts), snapshot);
  });

  it('ignores mappings not present in the changes map', () => {
    const accounts = [account({ connectionId: 'conn', actualAccountId: 'keep' })];

    const result = applyPairingChanges(accounts, 'conn', {});

    assert.equal(result.changed, 0);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].actualAccountId, 'keep');
  });
});

describe('findBudgetBySyncId', () => {
  const budgets: Budget[] = [
    { id: 'default', name: 'Default', syncId: 'sync-a' },
    { id: 'budget_1', name: 'Joint', syncId: 'sync-b' },
  ];

  it('finds another budget already using the sync id', () => {
    assert.equal(findBudgetBySyncId(budgets, 'sync-a')?.name, 'Default');
  });

  it('ignores the budget being updated', () => {
    assert.equal(findBudgetBySyncId(budgets, 'sync-a', 'default'), undefined);
  });

  it('returns undefined for an unused sync id', () => {
    assert.equal(findBudgetBySyncId(budgets, 'sync-c'), undefined);
  });
});

describe('duplicateSyncIdGroups', () => {
  it('groups budgets that point at the same Actual file', () => {
    const budgets: Budget[] = [
      { id: 'default', name: 'Default', syncId: 'sync-a' },
      { id: 'budget_1', name: 'Joint', syncId: 'sync-a' },
      { id: 'budget_2', name: 'Savings', syncId: 'sync-b' },
    ];

    const groups = duplicateSyncIdGroups(budgets);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((b) => b.name), ['Default', 'Joint']);
  });

  it('returns nothing when every sync id is distinct', () => {
    const budgets: Budget[] = [
      { id: 'default', name: 'Default', syncId: 'sync-a' },
      { id: 'budget_1', name: 'Joint', syncId: 'sync-b' },
    ];

    assert.deepEqual(duplicateSyncIdGroups(budgets), []);
  });
});

describe('DuplicateSyncIdError', () => {
  it('names the budget that already uses the sync id', () => {
    const err = new DuplicateSyncIdError('sync-a', { id: 'default', name: 'Default', syncId: 'sync-a' });
    assert.equal(err.name, 'DuplicateSyncIdError');
    assert.match(err.message, /already used by budget "Default"/);
  });
});

// ---------------------------------------------------------------------------
// File-backed tests (legacy migration, addBudget)
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-config-test-'));
const configPath = path.join(tmpDir, 'config.json');
setConfigPathForTests(configPath);

const savedEnv = {
  syncId: process.env.ACTUAL_SYNC_ID,
  password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
};

function writeConfig(data: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(data));
}

function readConfig(): { budgets: Budget[]; accounts: Account[] } {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

beforeEach(() => {
  fs.rmSync(configPath, { force: true });
  delete process.env.ACTUAL_SYNC_ID;
  delete process.env.ACTUAL_ENCRYPTION_PASSWORD;
});

after(() => {
  if (savedEnv.syncId === undefined) delete process.env.ACTUAL_SYNC_ID;
  else process.env.ACTUAL_SYNC_ID = savedEnv.syncId;
  if (savedEnv.password === undefined) delete process.env.ACTUAL_ENCRYPTION_PASSWORD;
  else process.env.ACTUAL_ENCRYPTION_PASSWORD = savedEnv.password;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const legacyAccount = {
  name: 'Current',
  connectionId: 'conn_1',
  truelayerAccountId: 'tl-1',
  actualAccountId: 'actual-1',
};

describe('budgetFromEnv', () => {
  it('returns null when ACTUAL_SYNC_ID is unset', () => {
    assert.equal(budgetFromEnv(), null);
  });

  it('builds the default budget from env vars', () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    process.env.ACTUAL_ENCRYPTION_PASSWORD = 'pw';
    assert.deepEqual(budgetFromEnv(), {
      id: 'default',
      name: 'Default',
      syncId: 'env-sync',
      encryptionPassword: 'pw',
    });
  });

  it('treats an empty encryption password as unset', () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    process.env.ACTUAL_ENCRYPTION_PASSWORD = '';
    assert.equal(budgetFromEnv()?.encryptionPassword, undefined);
  });
});

describe('loadConfig legacy migration', () => {
  it('seeds a "default" budget from env and defaults account budgetId', async () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    process.env.ACTUAL_ENCRYPTION_PASSWORD = 'pw';
    writeConfig({
      accounts: [legacyAccount, { ...legacyAccount, truelayerAccountId: 'tl-2' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const config = await loadConfig();

    assert.equal(config.budgets.length, 1);
    assert.equal(config.budgets[0].id, 'default');
    assert.equal(config.budgets[0].syncId, 'env-sync');
    assert.equal(config.budgets[0].encryptionPassword, 'pw');
    assert.deepEqual(config.accounts.map((a) => a.budgetId), ['default', 'default']);
  });

  it('does not rewrite the legacy file when loading', async () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    writeConfig({ accounts: [legacyAccount], createdAt: '2026-01-01T00:00:00.000Z' });
    const before = fs.readFileSync(configPath, 'utf-8');
    await loadConfig();
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
  });

  it('yields no budget when env is unset, and listBudgets is empty', async () => {
    writeConfig({ accounts: [legacyAccount], createdAt: '2026-01-01T00:00:00.000Z' });

    const config = await loadConfig();

    assert.deepEqual(config.budgets, []);
    assert.equal(config.accounts[0].budgetId, 'default');
    assert.deepEqual(await listBudgets(), []);
  });

  it('leaves existing budgets alone and defaults unset account budgetId to "default"', async () => {
    writeConfig({
      budgets: [{ id: 'budget_1', name: 'Joint', syncId: 'sync-j' }],
      accounts: [legacyAccount],
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const config = await loadConfig();

    assert.deepEqual(config.budgets.map((b) => b.id), ['budget_1']);
    assert.equal(config.accounts[0].budgetId, 'default');
  });

  it('prepends the env default budget when accounts reference "default" but it is missing', async () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    writeConfig({
      budgets: [{ id: 'budget_1', name: 'Joint', syncId: 'sync-j' }],
      accounts: [legacyAccount, { ...legacyAccount, truelayerAccountId: 'tl-2', budgetId: 'budget_1' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const config = await loadConfig();

    assert.deepEqual(config.budgets.map((b) => b.id), ['default', 'budget_1']);
  });

  it('does not add the env budget when no account references "default"', async () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    writeConfig({
      budgets: [{ id: 'budget_1', name: 'Joint', syncId: 'sync-j' }],
      accounts: [{ ...legacyAccount, budgetId: 'budget_1' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const config = await loadConfig();

    assert.deepEqual(config.budgets.map((b) => b.id), ['budget_1']);
  });
});

describe('listBudgets', () => {
  it('returns the env budget when there is no config file', async () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    const budgets = await listBudgets();
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].id, 'default');
    assert.equal(budgets[0].syncId, 'env-sync');
  });

  it('returns [] with no config file and no env', async () => {
    assert.deepEqual(await listBudgets(), []);
  });

  it('prefers configured budgets over the env fallback', async () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    writeConfig({
      budgets: [{ id: 'budget_1', name: 'Joint', syncId: 'sync-j' }],
      accounts: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual((await listBudgets()).map((b) => b.id), ['budget_1']);
  });

  it('falls back to the env budget when the config is corrupt', async () => {
    process.env.ACTUAL_SYNC_ID = 'env-sync';
    fs.writeFileSync(configPath, '{ broken');
    assert.deepEqual((await listBudgets()).map((b) => b.id), ['default']);
  });
});

describe('addBudget', () => {
  const baseConfig = () => ({
    budgets: [{ id: 'budget_1', name: 'Joint', syncId: 'sync-j' }],
    accounts: [{ ...legacyAccount, budgetId: 'budget_1' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('creates the config file when it does not exist', async () => {
    const budgets = await addBudget({ id: 'budget_new', name: 'New', syncId: 'sync-n' });
    assert.deepEqual(budgets.map((b) => b.id), ['budget_new']);
    assert.deepEqual(readConfig().budgets.map((b) => b.id), ['budget_new']);
    assert.deepEqual(readConfig().accounts, []);
  });

  it('appends to existing budgets and preserves accounts', async () => {
    writeConfig(baseConfig());
    await addBudget({ id: 'budget_2', name: 'Savings', syncId: 'sync-s' });
    const saved = readConfig();
    assert.deepEqual(saved.budgets.map((b) => b.id), ['budget_1', 'budget_2']);
    assert.equal(saved.accounts.length, 1);
  });

  it('rejects a duplicate sync id with DuplicateSyncIdError and leaves the config unchanged', async () => {
    writeConfig(baseConfig());
    const before = fs.readFileSync(configPath, 'utf-8');

    await assert.rejects(
      () => addBudget({ id: 'budget_dup', name: 'Dup', syncId: 'sync-j' }),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateSyncIdError);
        assert.equal(err.existing.id, 'budget_1');
        return true;
      }
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
  });

  it('allows re-saving the same budget id with the same sync id (update in place)', async () => {
    writeConfig(baseConfig());
    const budgets = await addBudget({ id: 'budget_1', name: 'Renamed', syncId: 'sync-j' });
    assert.equal(budgets.length, 1);
    assert.equal(readConfig().budgets[0].name, 'Renamed');
  });

  it('rejects and does not overwrite a corrupt config file', async () => {
    fs.writeFileSync(configPath, '{ broken json');
    await assert.rejects(() => addBudget({ id: 'budget_new', name: 'New', syncId: 'sync-n' }));
    assert.equal(fs.readFileSync(configPath, 'utf-8'), '{ broken json');
  });

  it('keeps both budgets for concurrent adds with different sync ids', async () => {
    await Promise.all([
      addBudget({ id: 'budget_a', name: 'A', syncId: 'sync-a' }),
      addBudget({ id: 'budget_b', name: 'B', syncId: 'sync-b' }),
    ]);
    assert.deepEqual(readConfig().budgets.map((b) => b.id).sort(), ['budget_a', 'budget_b']);
  });

  it('lets exactly one of two concurrent adds with the same sync id win', async () => {
    const results = await Promise.allSettled([
      addBudget({ id: 'budget_a', name: 'A', syncId: 'sync-same' }),
      addBudget({ id: 'budget_b', name: 'B', syncId: 'sync-same' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof DuplicateSyncIdError);
    assert.equal(readConfig().budgets.length, 1);
  });
});
