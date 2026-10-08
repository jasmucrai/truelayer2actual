import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the data files at a temp dir before importing the modules under test
// (paths are resolved lazily on first use).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-test-'));
const tokensPath = path.join(tmpDir, 'tokens.json');
const configPath = path.join(tmpDir, 'config.json');

import { setTokensPathForTests } from '../src/auth/tokens.js';
import { setConfigPathForTests } from '../src/config.js';
setTokensPathForTests(tokensPath);
setConfigPathForTests(configPath);

const { saveConnection, getConnection, removeStaleConnections, updateConnection } = await import(
  '../src/auth/tokens.js'
);
const { loadConfig, loadConfigIfExists, saveConfig } = await import('../src/config.js');

function validTokens() {
  return { accessToken: 'a', refreshToken: 'r', expiresAt: new Date().toISOString() };
}

function validConfig() {
  return {
    accounts: [
      {
        name: 'Current',
        connectionId: 'conn_a',
        accountKind: 'account' as const,
        truelayerAccountId: 'tl_1',
        actualAccountId: 'actual_1',
        currency: 'GBP',
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// tokens.json state safety
// ---------------------------------------------------------------------------

describe('tokens file state', () => {
  it('treats a missing tokens.json as empty', () => {
    assert.equal(getConnection('conn_x'), undefined);
  });

  it('throws on a corrupt-but-present tokens.json instead of treating it as empty', () => {
    saveConnection('conn_keep', validTokens());
    fs.writeFileSync(tokensPath, '{ not json', 'utf-8');

    assert.throws(() => getConnection('conn_keep'), /Failed to parse tokens file/);
  });

  it('throws on a structurally invalid tokens.json', () => {
    fs.writeFileSync(tokensPath, JSON.stringify({ connections: 'nope' }), 'utf-8');
    assert.throws(() => getConnection('conn_keep'), /Invalid tokens file/);
  });

  it('removeStaleConnections only deletes connections absent from the active set', () => {
    fs.writeFileSync(
      tokensPath,
      JSON.stringify({
        connections: {
          conn_keep: validTokens(),
          conn_drop: validTokens(),
        },
      })
    );

    removeStaleConnections(new Set(['conn_keep']));

    const remaining = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    assert.deepEqual(Object.keys(remaining.connections), ['conn_keep']);
  });

  it('updateConnection preserves fields it does not own (patch merge basis)', async () => {
    fs.writeFileSync(
      tokensPath,
      JSON.stringify({
        connections: {
          conn_keep: { ...validTokens(), lastAuthAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );

    await updateConnection('conn_keep', { accessToken: 'new-access' });
    const stored = JSON.parse(fs.readFileSync(tokensPath, 'utf-8')).connections.conn_keep;
    assert.equal(stored.lastAuthAt, '2026-01-01T00:00:00.000Z');
    assert.equal(stored.accessToken, 'new-access');
  });
});

// ---------------------------------------------------------------------------
// config.json state safety — the corrupt-config data-loss guards
// ---------------------------------------------------------------------------

describe('config file state', () => {
  it('loadConfig throws when config.json is missing', async () => {
    fs.rmSync(configPath, { force: true });
    await assert.rejects(() => loadConfig(), /Config file not found/);
  });

  it('loadConfigIfExists returns null when config.json is missing', async () => {
    fs.rmSync(configPath, { force: true });
    assert.equal(await loadConfigIfExists(), null);
  });

  it('loadConfigIfExists throws on corrupt-but-present config.json', async () => {
    fs.writeFileSync(configPath, '{ broken', 'utf-8');
    await assert.rejects(() => loadConfigIfExists(), /Failed to read or parse config file/);
  });

  it('loadConfigIfExists throws on structurally invalid config.json', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ accounts: 42 }), 'utf-8');
    await assert.rejects(() => loadConfigIfExists(), /Invalid config file/);
  });

  it('saveConfig writes mode 0600 and load round-trips the data', async () => {
    await saveConfig(validConfig());
    const mode = fs.statSync(configPath).mode & 0o777;
    assert.equal(mode, 0o600);

    const loaded = await loadConfigIfExists();
    assert.equal(loaded?.accounts[0].truelayerAccountId, 'tl_1');
  });

  it('saveConfig refuses to persist an invalid config', async () => {
    await assert.rejects(() =>
      saveConfig({ accounts: [{ name: 'x' }] as never, createdAt: 'x' })
    );
  });
});
