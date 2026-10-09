import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/util/errors.js';

// The Actual sync error shape from the field report: detail lives in
// meta.reason / meta.error.message, and err.message is empty — the case that
// produced "Failed to download Actual Budget budget: " with nothing after it.
function actualSyncError(reason: string, innerMessage: string): Error {
  const err = new Error('');
  err.name = 'SyncError';
  Object.assign(err, {
    reason,
    meta: {
      error: { message: innerMessage, stack: 'SqliteError: ...' },
      query: { sql: 'UPDATE categories SET cleanup_def = ? WHERE id = ?', params: [] },
    },
  });
  return err;
}

describe('describeError', () => {
  it('extracts meta.reason and nested meta.error.message from Actual sync errors', () => {
    const text = describeError(actualSyncError('invalid-schema', 'no such column: cleanup_def'));
    assert.ok(text.includes('invalid-schema'), `missing reason in: ${text}`);
    assert.ok(text.includes('no such column: cleanup_def'), `missing detail in: ${text}`);
  });

  it('does not lose a plain message', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
  });

  it('prefixes non-generic error names', () => {
    const err = new Error('budget locked');
    err.name = 'ActualCompatibilityError';
    assert.equal(describeError(err), 'ActualCompatibilityError: budget locked');
  });

  it('extracts axios-style response bodies', () => {
    const err = Object.assign(new Error('Request failed'), {
      response: { data: { error: 'invalid_client' } },
    });
    assert.ok(describeError(err).includes('{"error":"invalid_client"}'));
  });

  it('follows cause chains', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new Error('request failed', { cause });
    const text = describeError(err);
    assert.ok(text.includes('request failed'), text);
    assert.ok(text.includes('ECONNREFUSED'), text);
  });

  it('falls back to own-property stringify for exotic error shapes', () => {
    const err = Object.assign(new Error(''), { code: 'ESOMETHING' });
    const text = describeError(err);
    assert.ok(text.includes('ESOMETHING'), text);
  });

  it('handles non-error and nullish inputs without throwing', () => {
    assert.equal(describeError('plain string'), 'plain string');
    assert.equal(describeError(null), 'null');
    assert.equal(describeError(undefined), 'undefined');
    assert.equal(describeError(42), '42');
  });

  it('never throws on circular structures', () => {
    const err: Record<string, unknown> = new Error('circular');
    err.self = err;
    assert.doesNotThrow(() => describeError(err));
  });
});
