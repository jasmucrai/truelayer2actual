import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncIntervalHours,
  DEFAULT_SYNC_INTERVAL_HOURS,
  MAX_SYNC_INTERVAL_HOURS,
} from '../src/config.js';
import { actualApiVersion } from '../src/clients/actual.js';

describe('syncIntervalHours (always-on scheduler)', () => {
  it('defaults when unset or blank', () => {
    assert.equal(syncIntervalHours(undefined), DEFAULT_SYNC_INTERVAL_HOURS);
    assert.equal(syncIntervalHours('  '), DEFAULT_SYNC_INTERVAL_HOURS);
  });

  it('ignores 0 (one-shot only applies to sync.js) and keeps the default', () => {
    assert.equal(syncIntervalHours('0'), DEFAULT_SYNC_INTERVAL_HOURS);
  });

  it('accepts positive values, including fractions', () => {
    assert.equal(syncIntervalHours('12'), 12);
    assert.equal(syncIntervalHours('0.5'), 0.5);
  });

  it('falls back on invalid or negative values', () => {
    assert.equal(syncIntervalHours('abc'), DEFAULT_SYNC_INTERVAL_HOURS);
    assert.equal(syncIntervalHours('-3'), DEFAULT_SYNC_INTERVAL_HOURS);
  });

  it('clamps values that would overflow setInterval', () => {
    assert.equal(syncIntervalHours('1000'), MAX_SYNC_INTERVAL_HOURS);
    assert.ok(MAX_SYNC_INTERVAL_HOURS * 3_600_000 <= 2 ** 31 - 1);
  });
});

describe('actualApiVersion', () => {
  it('reports the installed @actual-app/api version, not "unknown"', () => {
    assert.match(actualApiVersion(), /^\d+\.\d+\.\d+/);
  });
});
