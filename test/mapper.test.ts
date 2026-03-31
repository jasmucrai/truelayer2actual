import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Mock @actual-app/api before importing mapper
// ---------------------------------------------------------------------------
// Node's built-in test runner has no jest-style module mocking.
// We patch the module cache directly so that mapper.ts receives our mock
// when it calls `require('@actual-app/api')`.
//
// amountToInteger: convert decimal pounds → integer pence
const mockAmountToInteger = (n: number): number => Math.round(n * 100);

// Inject the mock into Node's require cache before importing mapper
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Pre-populate the require cache with a lightweight mock
require.cache['@actual-app/api'] = {
  id: '@actual-app/api',
  filename: '@actual-app/api',
  loaded: true,
  parent: null,
  children: [],
  path: '',
  paths: [],
  exports: {
    utils: {
      amountToInteger: mockAmountToInteger,
    },
  },
} as unknown as NodeJS.Module;

// Now import mapper — it will receive the mocked @actual-app/api
const { mapTransaction } = await import('../src/mapper.js');

import type { TrueLayerTransaction } from '../src/clients/truelayer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTransaction(
  overrides: Partial<TrueLayerTransaction> = {}
): TrueLayerTransaction {
  return {
    transaction_id: 'txn-001',
    timestamp: '2024-03-15T10:30:00Z',
    amount: -12.5,
    currency: 'GBP',
    transaction_type: 'debit',
    transaction_classification: ['Shopping'],
    description: 'TESCO SUPERSTORE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapTransaction', () => {
  it('maps a basic debit transaction — negative amount to negative pence', () => {
    const t = makeTransaction({ amount: -12.5 });
    const result = mapTransaction(t);

    assert.equal(result.amount, -1250, 'amount should be -1250 pence');
    assert.equal(result.imported_id, 'txn-001');
    assert.equal(result.date, '2024-03-15');
  });

  it('maps a credit transaction — positive amount to positive pence', () => {
    const t = makeTransaction({
      amount: 500.0,
      transaction_type: 'credit',
      description: 'Salary payment',
    });
    const result = mapTransaction(t);

    assert.equal(result.amount, 50000, 'amount should be 50000 pence');
    assert.equal(result.imported_id, 'txn-001');
  });

  it('uses merchant_name when available', () => {
    const t = makeTransaction({
      merchant_name: 'Tesco',
      description: 'TESCO SUPERSTORE REF 123',
    });
    const result = mapTransaction(t);

    assert.equal(result.payee_name, 'Tesco');
  });

  it('falls back to description when merchant_name is absent', () => {
    const t = makeTransaction({
      merchant_name: undefined,
      description: 'TESCO SUPERSTORE REF 123',
    });
    const result = mapTransaction(t);

    assert.equal(result.payee_name, 'TESCO SUPERSTORE REF 123');
  });

  it('sets cleared=true when status is "booked"', () => {
    const t = makeTransaction({ status: 'booked' });
    const result = mapTransaction(t);

    assert.equal(result.cleared, true);
  });

  it('sets cleared=false when status is "pending"', () => {
    const t = makeTransaction({ status: 'pending' });
    const result = mapTransaction(t);

    assert.equal(result.cleared, false);
  });

  it('defaults cleared=true when status field is absent', () => {
    const t = makeTransaction();
    // Ensure no status field
    const { status: _removed, ...tWithoutStatus } = t as TrueLayerTransaction & { status?: string };
    const result = mapTransaction(tWithoutStatus as TrueLayerTransaction);

    assert.equal(result.cleared, true);
  });

  it('always sets imported_id from transaction_id', () => {
    const t = makeTransaction({ transaction_id: 'unique-txn-xyz-789' });
    const result = mapTransaction(t);

    assert.equal(result.imported_id, 'unique-txn-xyz-789');
  });

  it('extracts date from ISO 8601 timestamp correctly', () => {
    const t = makeTransaction({ timestamp: '2024-12-31T23:59:59.999Z' });
    const result = mapTransaction(t);

    assert.equal(result.date, '2024-12-31');
  });

  it('stores description in notes field', () => {
    const t = makeTransaction({ description: 'Some transfer reference' });
    const result = mapTransaction(t);

    assert.equal(result.notes, 'Some transfer reference');
  });

  it('handles fractional pence rounding correctly', () => {
    // e.g. £10.005 should round to 1001 or 1000 depending on Math.round
    const t = makeTransaction({ amount: -10.005 });
    const result = mapTransaction(t);

    assert.equal(result.amount, -1001);
  });
});
