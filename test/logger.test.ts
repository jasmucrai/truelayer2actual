import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/logger.js';

describe('logger', () => {
  it('does not throw on circular references or BigInt values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const write = process.stdout.write;
    let out = '';
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      logger.info('value', circular, { n: 1n });
    } finally {
      process.stdout.write = write;
    }
    assert.match(out, /\[unserialisable\] \[unserialisable\]/);
  });
});
