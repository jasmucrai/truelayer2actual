import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the data files at a temp dir before importing (paths resolve lazily).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-callback-'));
const tokensPath = path.join(tmpDir, 'tokens.json');
const configPath = path.join(tmpDir, 'config.json');

import { setTokensPathForTests } from '../src/auth/tokens.js';
import { setConfigPathForTests } from '../src/config.js';
setTokensPathForTests(tokensPath);
setConfigPathForTests(configPath);

// Node 20's test runner has no mock.module, so intercept axios at the HTTP
// adapter layer instead: an axios interceptor that answers every request
// from a per-URL responder table and never touches the network.
import axios from 'axios';

let responder: (config: {
  method?: string;
  url: string;
  data?: unknown;
}) => { status: number; data: unknown } = () => ({
  status: 500,
  data: { error: 'no responder installed' },
});

const interceptorId = axios.interceptors.request.use(async (config) => {
  const method = (config.method ?? 'get').toLowerCase();
  const url = `${config.baseURL ?? ''}${config.url ?? ''}`;
  const res = responder({ method, url, data: config.data });
  config.adapter = async () => ({
    data: res.data,
    status: res.status,
    statusText: '',
    headers: {},
    config,
  });
  return config;
});

function tokenExchangeBody() {
  return { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };
}

function meBody() {
  return {
    results: [
      {
        provider: { provider_id: 'monzo', display_name: 'Monzo' },
        consent_expires_at: '2027-01-01T00:00:00Z',
        consent_status: 'active',
      },
    ],
    status: 'Succeed',
  };
}

function installHappyPathResponder(): void {
  responder = ({ url }) => {
    if (url.includes('/connect/token')) return { status: 200, data: tokenExchangeBody() };
    if (url.includes('/data/v1/me')) return { status: 200, data: meBody() };
    if (url.includes('/accounts'))
      return {
        status: 200,
        data: {
          results: [
            {
              account_id: 'tl_new',
              display_name: 'Current',
              currency: 'GBP',
              account_type: 'UK',
              provider: { display_name: 'Monzo' },
            },
          ],
          status: 'Succeed',
        },
      };
    return { status: 200, data: { results: [], status: 'Succeed' } };
  };
}

process.env.TRUELAYER_CLIENT_ID = 'test-client';
process.env.TRUELAYER_CLIENT_SECRET = 'test-secret';
process.env.TRUELAYER_REDIRECT_URI = 'http://192.168.1.73:3000/callback';

const { setPending, processCallback, savePairings } = await import('../src/web/oauth.js');

function validTokens() {
  return { accessToken: 'old-a', refreshToken: 'old-r', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
}

function resetFiles(): void {
  fs.writeFileSync(tokensPath, JSON.stringify({ connections: { conn_keep: validTokens() } }));
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      accounts: [
        {
          name: 'Other bank',
          connectionId: 'conn_keep',
          accountKind: 'account',
          truelayerAccountId: 'tl_keep',
          actualAccountId: 'actual_keep',
          currency: 'GBP',
        },
      ],
      createdAt: new Date().toISOString(),
    })
  );
}

after(() => {
  axios.interceptors.request.eject(interceptorId);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('processCallback', () => {
  it('returns an error outcome for OAuth error params (e.g. closed consent screen)', async () => {
    const outcome = await processCallback({
      error: 'access_denied',
      errorDescription: 'User closed the consent screen',
      state: 'whatever',
    });
    assert.equal(outcome.type, 'error');
    assert.match(outcome.message, /User closed the consent screen/);
  });

  it('falls back to the raw error code when no description is provided', async () => {
    const outcome = await processCallback({ error: 'access_denied' });
    assert.equal(outcome.type, 'error');
    assert.equal(outcome.message, 'access_denied');
  });

  it('rejects a missing code', async () => {
    const outcome = await processCallback({ state: 'some-state' });
    assert.equal(outcome.type, 'error');
    assert.match(outcome.message, /No authorization code/);
  });

  it('rejects a missing state', async () => {
    const outcome = await processCallback({ code: 'abc' });
    assert.equal(outcome.type, 'error');
    assert.match(outcome.message, /Missing state/);
  });

  it('rejects an unknown or expired state without touching stored tokens', async () => {
    resetFiles();
    const before = fs.readFileSync(tokensPath, 'utf-8');

    const outcome = await processCallback({ code: 'abc', state: 'never-issued' });
    assert.equal(outcome.type, 'error');
    assert.match(outcome.message, /Unknown or expired authorization state/);

    assert.equal(fs.readFileSync(tokensPath, 'utf-8'), before);
  });

  it('processes a valid new-connection callback without disturbing other banks', async () => {
    resetFiles();
    installHappyPathResponder();
    setPending('state_new', { mode: 'new' });

    const outcome = await processCallback({ code: 'abc', state: 'state_new' });

    assert.equal(outcome.type, 'pair');
    // New account tl_new is unmapped → pairing page offered.
    if (outcome.type === 'pair') {
      assert.equal(outcome.session.items[0].truelayerAccountId, 'tl_new');
    }

    // The other bank's connection must still exist.
    const tokensFile = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    assert.ok(tokensFile.connections.conn_keep, 'other bank connection wiped!');
    assert.ok(Object.keys(tokensFile.connections).length >= 2);

    // The other bank's config mapping must still exist.
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.ok(
      config.accounts.some((a: { truelayerAccountId: string }) => a.truelayerAccountId === 'tl_keep')
    );
  });

  it('does not prune other connections when config.json is corrupt (hard error path)', async () => {
    resetFiles();
    installHappyPathResponder();
    setPending('state_corrupt', { mode: 'new' });
    // Corrupt the config: the callback must abort reconciliation/pruning
    // but still keep the fresh token grant.
    fs.writeFileSync(configPath, '{ broken json', 'utf-8');

    const outcome = await processCallback({ code: 'abc', state: 'state_corrupt' });

    if (outcome.type === 'pair') {
      assert.match(outcome.warning ?? '', /Config file could not be loaded/);
    } else if (outcome.type === 'done') {
      assert.match(outcome.message, /Config file could not be loaded/);
    } else {
      assert.fail(`unexpected outcome: ${JSON.stringify(outcome)}`);
    }

    // The fresh token grant for the new connection was still saved...
    const tokensFile = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    assert.ok(Object.keys(tokensFile.connections).length >= 2);
    // ...and the other bank's connection was NOT pruned.
    assert.ok(tokensFile.connections.conn_keep, 'corrupt config must not trigger pruning');
  });
});

describe('savePairings', () => {
  it('refuses to save when config.json exists but is corrupt (no wipe)', async () => {
    resetFiles();
    installHappyPathResponder();
    fs.writeFileSync(configPath, '{ broken', 'utf-8');

    // Drive a live pairing session through processCallback.
    setPending('state_pair', { mode: 'new' });
    const outcome = await processCallback({ code: 'abc', state: 'state_pair' });
    assert.equal(outcome.type, 'pair');
    if (outcome.type !== 'pair') return;

    await assert.rejects(
      () => savePairings(outcome.pairingId, { tl_new: 'actual_1' }),
      /Config file could not be loaded/
    );

    // The other bank's tokens must be intact.
    const tokensFile = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    assert.ok(tokensFile.connections.conn_keep, 'savePairings wiped other connections!');
  });

  it('keeps the pairing session usable after a failed save (retry works)', async () => {
    resetFiles();
    installHappyPathResponder();
    fs.writeFileSync(configPath, '{ broken', 'utf-8');

    setPending('state_retry', { mode: 'new' });
    const outcome = await processCallback({ code: 'abc', state: 'state_retry' });
    assert.equal(outcome.type, 'pair');
    if (outcome.type !== 'pair') return;

    await assert.rejects(() => savePairings(outcome.pairingId, { tl_new: 'actual_1' }));

    // Fix the config and retry — the session must still be alive.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ accounts: [], createdAt: new Date().toISOString() })
    );

    const result = await savePairings(outcome.pairingId, { tl_new: 'actual_1' });
    assert.equal(result.saved, 1);
  });
});
