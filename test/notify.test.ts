import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { once } from 'events';

// Point tokens.json at a temp dir before importing (paths resolve lazily).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-notify-'));
const tokensPath = path.join(tmpDir, 'tokens.json');

import { setTokensPathForTests } from '../src/auth/tokens.js';
setTokensPathForTests(tokensPath);

const { saveConnection, getConnection } = await import('../src/auth/tokens.js');
const { notifyConnection } = await import('../src/notify.js');

function validTokens() {
  return { accessToken: 'a', refreshToken: 'r', expiresAt: new Date().toISOString() };
}

// One-shot HTTP sink that records requests and replies. Supports a "failing"
// mode where every delivery returns 500.
let received: { url: string; body: string }[] = [];
let backendFails = false;

const backend = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ url: req.url ?? '', body });
    res.writeHead(backendFails ? 500 : 204);
    res.end();
  });
});
await once(backend.listen(0, '127.0.0.1'), 'listening');
const backendPort = (backend.address() as { port: number }).port;

const originalEnv = { ...process.env };

function resetTokens() {
  fs.writeFileSync(
    tokensPath,
    JSON.stringify({ connections: { conn_1: validTokens() } })
  );
}

after(async () => {
  backend.close();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('notifyConnection dedupe', () => {
  before(() => {
    process.env.NTFY_URL = `http://127.0.0.1:${backendPort}/topic`;
    delete process.env.HA_WEBHOOK_URL;
  });

  it('sends the first notification and records the dedupe marker', async () => {
    resetTokens();
    received = [];
    backendFails = false;

    await notifyConnection('conn_1', 'refresh_token_invalid', {
      title: 'Reconnect',
      message: 'expired',
    });
    // Fire-and-forget delivery — wait a tick for the sink to record it.
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(received.length, 1);
    const marked = getConnection('conn_1');
    assert.equal(marked?.lastNotifiedReason, 'refresh_token_invalid');
    assert.ok(marked?.lastNotifiedAt);
  });

  it('suppresses a duplicate reason within 24h', async () => {
    resetTokens();
    received = [];
    backendFails = false;

    await notifyConnection('conn_1', 'refresh_token_invalid', {
      title: 'Reconnect',
      message: 'expired',
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);

    await notifyConnection('conn_1', 'refresh_token_invalid', {
      title: 'Reconnect',
      message: 'expired',
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1, 'duplicate must be suppressed');
  });

  it('does not suppress a different reason', async () => {
    resetTokens();
    received = [];
    backendFails = false;

    await notifyConnection('conn_1', 'refresh_token_invalid', {
      title: 'A',
      message: 'x',
    });
    await new Promise((r) => setTimeout(r, 100));

    await notifyConnection('conn_1', 'consent_expired', { title: 'B', message: 'y' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 2);
  });

  it('releases the dedupe marker when all backends fail, so the next run retries', async () => {
    resetTokens();
    received = [];
    backendFails = true;

    await notifyConnection('conn_1', 'refresh_token_invalid', {
      title: 'Reconnect',
      message: 'expired',
    });
    await new Promise((r) => setTimeout(r, 150));

    // Delivery failed — the marker must have been released.
    const afterFailure = getConnection('conn_1');
    assert.equal(afterFailure?.lastNotifiedReason, undefined);
    assert.equal(afterFailure?.lastNotifiedAt, undefined);

    // Retry after the backend recovers must go out.
    const attemptsAfterFailure = received.length;
    backendFails = false;
    await notifyConnection('conn_1', 'refresh_token_invalid', {
      title: 'Reconnect',
      message: 'expired',
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, attemptsAfterFailure + 1);
  });

  it('never throws and never blocks on a slow backend', async () => {
    resetTokens();
    // No backends configured at all.
    delete process.env.NTFY_URL;
    received = [];

    await assert.doesNotReject(() =>
      notifyConnection('conn_1', 'consent_expiring', { title: 'X', message: 'y' })
    );
    assert.equal(received.length, 0);
  });
});
