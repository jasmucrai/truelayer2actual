import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// sync.ts pulls in the Actual client; stub the library so importing it is cheap.
const require = createRequire(import.meta.url);
const resolvedApiPath = require.resolve('@actual-app/api');
require.cache[resolvedApiPath] = {
  id: resolvedApiPath,
  filename: resolvedApiPath,
  loaded: true,
  parent: null,
  children: [],
  path: '',
  paths: [],
  exports: {},
} as unknown as NodeJS.Module;

const { groupAccountsByBudget } = await import('../src/commands/sync.js');
import type { Account, Budget } from '../src/config.js';

function account(overrides: Partial<Account> = {}): Account {
  return {
    name: 'Acct',
    connectionId: 'conn_a',
    budgetId: 'default',
    accountKind: 'account',
    truelayerAccountId: 'tl-1',
    actualAccountId: 'actual-1',
    currency: 'GBP',
    ...overrides,
  };
}

const budgets: Budget[] = [
  { id: 'default', name: 'Default', syncId: 'sync-a' },
  { id: 'budget_1', name: 'Joint', syncId: 'sync-b' },
];

describe('groupAccountsByBudget', () => {
  it('groups accounts by budget, keeping only accounts with a usable token as ready', () => {
    const accounts = [
      account({ name: 'A1', truelayerAccountId: 'tl-1', connectionId: 'conn_a' }),
      account({ name: 'A2', truelayerAccountId: 'tl-2', connectionId: 'conn_dead' }),
      account({ name: 'B1', truelayerAccountId: 'tl-3', connectionId: 'conn_a', budgetId: 'budget_1' }),
    ];

    const result = groupAccountsByBudget({ budgets, accounts }, new Set(['conn_a']));

    assert.deepEqual(result.groups.map((g) => g.budget.id), ['default', 'budget_1']);
    assert.deepEqual(result.groups[0].accounts.map((a) => a.name), ['A1', 'A2']);
    assert.deepEqual(result.groups[0].ready.map((a) => a.name), ['A1']);
    assert.deepEqual(result.groups[1].ready.map((a) => a.name), ['B1']);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
  });

  it('reports accounts that reference an unknown budget and does not group them', () => {
    const accounts = [
      account({ name: 'Orphan', connectionId: 'conn_a', budgetId: 'budget_gone' }),
      account({ name: 'Fine', truelayerAccountId: 'tl-2', connectionId: 'conn_a' }),
    ];

    const result = groupAccountsByBudget({ budgets, accounts }, new Set(['conn_a']));

    assert.deepEqual(result.groups.map((g) => g.budget.id), ['default']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].account, 'Orphan');
    assert.equal(result.errors[0].connectionId, 'conn_a');
    assert.match(result.errors[0].reason, /Unknown budget "budget_gone"/);
  });

  it('reports unknown-budget errors even when the connection is unusable', () => {
    const accounts = [account({ budgetId: 'budget_gone' })];
    const result = groupAccountsByBudget({ budgets: [], accounts }, new Set());
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.groups, []);
    assert.deepEqual(result.skipped, []);
  });

  it('skips a budget (no download) when none of its banks have a token', () => {
    const accounts = [
      account({ name: 'A1', connectionId: 'conn_dead' }),
      account({ name: 'B1', truelayerAccountId: 'tl-2', connectionId: 'conn_a', budgetId: 'budget_1' }),
    ];

    const result = groupAccountsByBudget({ budgets, accounts }, new Set(['conn_a']));

    assert.deepEqual(result.groups.map((g) => g.budget.id), ['budget_1']);
    assert.deepEqual(result.skipped.map((g) => g.budget.id), ['default']);
    assert.deepEqual(result.skipped[0].accounts.map((a) => a.name), ['A1']);
    assert.deepEqual(result.skipped[0].ready, []);
    assert.deepEqual(result.errors, []);
  });

  it('returns nothing for no accounts', () => {
    const result = groupAccountsByBudget({ budgets, accounts: [] }, new Map());
    assert.deepEqual(result, { groups: [], skipped: [], errors: [] });
  });
});
