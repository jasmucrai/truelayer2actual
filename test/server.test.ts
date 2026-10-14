import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import axios from 'axios';
import { createRequire } from 'module';
import type { Express } from 'express';
import { createHash } from 'crypto';
import { setTokensPathForTests, saveConnection } from '../src/auth/tokens.js';
import { setConfigPathForTests } from '../src/config.js';
import { pairingPage, PAIRING_SCRIPT_CSP_SOURCE } from '../src/web/pages.js';

// Point tokens.json at a temp dir before importing the server (paths are
// resolved lazily on first use, same pattern as test/state.test.ts).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2a-server-test-'));
setTokensPathForTests(path.join(tmpDir, 'tokens.json'));
const configFile = path.join(tmpDir, 'config.json');
setConfigPathForTests(configFile);

// Stub @actual-app/api via the require cache (same approach as test/actual.test.ts)
// so the pairing page can list Actual accounts without a real server.
const nodeRequire = createRequire(import.meta.url);
const resolvedApiPath = nodeRequire.resolve('@actual-app/api');
let loadedGroupId: string | null = null;
const actualAccountsBySync: Record<string, { id: string; name: string; offbudget: boolean; closed: boolean }[]> = {};
nodeRequire.cache[resolvedApiPath] = {
  id: resolvedApiPath,
  filename: resolvedApiPath,
  loaded: true,
  parent: null,
  children: [],
  path: '',
  paths: [],
  exports: {
    init: async () => {},
    downloadBudget: async (syncId: string) => {
      loadedGroupId = syncId;
    },
    shutdown: async () => {},
    getAccounts: async () => actualAccountsBySync[loadedGroupId ?? ''] ?? [],
    internal: { send: async () => (loadedGroupId === null ? null : { groupId: loadedGroupId }) },
  },
} as unknown as NodeJS.Module;
process.env.ACTUAL_SERVER_URL ??= 'http://actual.invalid';
process.env.ACTUAL_PASSWORD ??= 'secret';

const { createApp, hostAllowed } = await import('../src/web/server.js');
const { setPairing } = await import('../src/web/oauth.js');

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  app: Express,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body;
    const req = http.request(
      {
        method: opts.method ?? 'GET',
        headers: {
          ...(payload !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...opts.headers,
        },
        port: serverAddress.port,
        hostname: '127.0.0.1',
        path,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data })
        );
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const serverAddress = server.address() as { port: number };

after(() => {
  server.close();
});

describe('security headers', () => {
  it('sets CSP, nosniff, X-Frame-Options, Referrer-Policy and no-store on HTML pages', async () => {
    const res = await request(app, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'] ?? '', /default-src 'none'/);
    assert.match(res.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    // Must not be no-referrer: that makes browsers send `Origin: null` on the
    // dashboard's own form POSTs, which the origin check rejects.
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

describe('origin check on state-changing POSTs', () => {
  const pairBody = 'pairingId=nonexistent';

  it('rejects a cross-site Origin', async () => {
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
      body: pairBody,
    });
    assert.equal(res.status, 403);
  });

  it('rejects Sec-Fetch-Site: cross-site even without an Origin header', async () => {
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      body: pairBody,
    });
    assert.equal(res.status, 403);
  });

  it('rejects a cross-site Origin that matches DASHBOARD_URL when Host does not', async () => {
    process.env.DASHBOARD_URL = 'https://dash.example.com';
    try {
      const res = await request(app, '/pair', {
        method: 'POST',
        headers: { Origin: 'https://other.example.com' },
        body: pairBody,
      });
      assert.equal(res.status, 403);
    } finally {
      delete process.env.DASHBOARD_URL;
    }
  });

  it('allows an Origin matching DASHBOARD_URL even when Host differs (proxy rewrites Host)', async () => {
    process.env.DASHBOARD_URL = 'https://dash.example.com';
    try {
      const res = await request(app, '/pair', {
        method: 'POST',
        headers: { Origin: 'https://dash.example.com', Host: 'internal:3000' },
        body: pairBody,
      });
      assert.notEqual(res.status, 403);
    } finally {
      delete process.env.DASHBOARD_URL;
    }
  });

  it('allows a same-origin POST (Origin matches the request Host)', async () => {
    // Origin allowed → the request reaches the route and fails later (unknown
    // pairing session, 500), proving the 403 origin check did not fire.
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${serverAddress.port}` },
      body: pairBody,
    });
    assert.notEqual(res.status, 403);
  });

  it('allows a direct-IP same-origin POST even when DASHBOARD_URL is set to another host', async () => {
    // Regression: the brief "both Origin and Host must match DASHBOARD_URL"
    // rule broke browsing via the raw LAN IP while DASHBOARD_URL pointed at a
    // proxy host. Same-origin (Origin === Host) must always be allowed.
    process.env.DASHBOARD_URL = 'https://dash.example.com';
    try {
      const res = await request(app, '/pair', {
        method: 'POST',
        headers: { Origin: 'http://192.168.1.73:3000', Host: '192.168.1.73:3000' },
        body: pairBody,
      });
      assert.notEqual(res.status, 403);
    } finally {
      delete process.env.DASHBOARD_URL;
    }
  });

  it('allows a raw-IP same-origin POST when DASHBOARD_URL is empty or unset', async () => {
    for (const value of [undefined, '']) {
      if (value === undefined) delete process.env.DASHBOARD_URL;
      else process.env.DASHBOARD_URL = value;
      try {
        const res = await request(app, '/pair', {
          method: 'POST',
          headers: { Origin: 'http://192.168.1.73:3000', Host: '192.168.1.73:3000' },
          body: pairBody,
        });
        assert.notEqual(res.status, 403, `DASHBOARD_URL=${JSON.stringify(value)}`);
      } finally {
        delete process.env.DASHBOARD_URL;
      }
    }
  });

  it('allows a non-standard-port same-origin POST (Origin host includes the port)', async () => {
    // URL().host includes a non-default port; the comparison must be on the
    // full host:port, not just the hostname.
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: { Origin: `http://192.168.1.73:${serverAddress.port}`, Host: `192.168.1.73:${serverAddress.port}` },
      body: pairBody,
    });
    assert.notEqual(res.status, 403);
  });

  it('rejects a same-host-but-different-port Origin (cross-origin)', async () => {
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: { Origin: `http://192.168.1.73:9999`, Host: `192.168.1.73:${serverAddress.port}` },
      body: pairBody,
    });
    assert.equal(res.status, 403);
  });

  it('rejects an Origin whose port differs from the Host port', async () => {
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${serverAddress.port + 1}`,
        Host: `127.0.0.1:${serverAddress.port}`,
      },
      body: pairBody,
    });
    assert.equal(res.status, 403);
  });

  it('rejects a malformed Origin header', async () => {
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: { Origin: 'not a url' },
      body: pairBody,
    });
    assert.equal(res.status, 403);
  });

  it('rejects Sec-Fetch-Site: cross-site even when Origin would be allowed', async () => {
    // A forged same-origin-looking Origin with a cross-site Fetch-Metadata
    // header must still be rejected (Fetch-Metadata is set by the browser and
    // cannot be stripped by the attacking page's JS).
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${serverAddress.port}`,
        Host: `127.0.0.1:${serverAddress.port}`,
        'Sec-Fetch-Site': 'cross-site',
      },
      body: pairBody,
    });
    assert.equal(res.status, 403);
  });

  it('allows Sec-Fetch-Site: same-origin and same-site', async () => {
    for (const site of ['same-origin', 'same-site']) {
      const res = await request(app, '/pair', {
        method: 'POST',
        headers: {
          Origin: `http://127.0.0.1:${serverAddress.port}`,
          'Sec-Fetch-Site': site,
        },
        body: pairBody,
      });
      assert.notEqual(res.status, 403, `Sec-Fetch-Site: ${site}`);
    }
  });

  it('rejects an opaque "null" Origin (sandboxed iframe/webview)', async () => {
    // A sandboxed attacker iframe sends the literal "null"; the dashboard's own
    // forms never do, so it must not be treated like an absent Origin.
    const res = await request(app, '/pair', {
      method: 'POST',
      headers: { Origin: 'null' },
      body: pairBody,
    });
    assert.equal(res.status, 403);
  });

  it('allows POSTs to /sync and /connections/:id/reauth with a same-origin Origin', async () => {
    const syncRes = await request(app, '/sync', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${serverAddress.port}` },
      body: '',
    });
    assert.notEqual(syncRes.status, 403);

    const reauthRes = await request(app, '/connections/conn_unknown/reauth', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${serverAddress.port}` },
      body: '',
    });
    assert.notEqual(reauthRes.status, 403);
  });

  it('allows an Origin matching DASHBOARD_URL when Host matches too', async () => {
    process.env.DASHBOARD_URL = 'https://dash.example.com';
    try {
      const res = await request(app, '/pair', {
        method: 'POST',
        headers: {
          Origin: 'https://dash.example.com',
          Host: 'dash.example.com',
        },
        body: pairBody,
      });
      assert.notEqual(res.status, 403);
    } finally {
      delete process.env.DASHBOARD_URL;
    }
  });
});

describe('GET /connections/:id/delete (confirmation page)', () => {
  it('returns 404 for an unknown connection id', async () => {
    const res = await request(app, '/connections/conn_unknown/delete');
    assert.equal(res.status, 404);
  });

  it('returns 200 with a confirmation page, and no inline onsubmit handler', async () => {
    saveConnection('conn_delete_me', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date().toISOString(),
      providerDisplayName: 'Test Bank',
    });

    const res = await request(app, '/connections/conn_delete_me/delete');
    assert.equal(res.status, 200);
    assert.match(res.body, /delete/i);
    assert.doesNotMatch(res.body, /onsubmit/);
  });
});

describe('GET /healthz', () => {
  it('returns 200 with a minimal connection shape (no ids or provider names)', async () => {
    const res = await request(app, '/healthz');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body) as {
      status: string;
      connections: Record<string, unknown>[];
    };
    assert.ok(['ok', 'degraded'].includes(json.status));
    for (const entry of json.connections) {
      const keys = Object.keys(entry);
      for (const key of keys) {
        assert.ok(
          key === 'needsReauth' || key === 'consentExpiresAt',
          `unexpected key "${key}" exposed by /healthz`
        );
      }
    }
  });
});

describe('Host allow-list (DNS-rebinding defence)', () => {
  it('allows IP literals, localhost, LAN and Tailscale names', () => {
    for (const host of [
      '127.0.0.1:3000',
      '192.168.1.73:3000',
      '[::1]:3000',
      'localhost:3000',
      'nas:3000',
      'diskstation.local:3000',
      'nas.home.arpa',
      'nas.tail1234.ts.net',
      'NAS.LOCAL.',
    ]) {
      assert.equal(hostAllowed(host), true, host);
    }
  });

  it('rejects public domain names that are not configured', () => {
    for (const host of ['evil.example.com', 'evil.example.com:3000', 'localhost.evil.com', 'local.evil.com']) {
      assert.equal(hostAllowed(host), false, host);
    }
  });

  it('allows the DASHBOARD_URL host and ALLOWED_HOSTS entries', () => {
    process.env.DASHBOARD_URL = 'https://dash.example.com';
    process.env.ALLOWED_HOSTS = ' budget.example.org , other.example.net:8443 ';
    try {
      assert.equal(hostAllowed('dash.example.com'), true);
      assert.equal(hostAllowed('budget.example.org:3000'), true);
      assert.equal(hostAllowed('other.example.net'), true);
      assert.equal(hostAllowed('evil.example.com'), false);
    } finally {
      delete process.env.DASHBOARD_URL;
      delete process.env.ALLOWED_HOSTS;
    }
  });

  it('rejects a rebinding page: GET / with a foreign Host', async () => {
    const res = await request(app, '/', { headers: { Host: 'rebind.attacker.example:3000' } });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /Add bank/);
  });

  it('rejects a rebinding POST even when Origin matches its Host', async () => {
    const res = await request(app, '/sync', {
      method: 'POST',
      headers: {
        Host: 'rebind.attacker.example:3000',
        Origin: 'http://rebind.attacker.example:3000',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '',
    });
    assert.equal(res.status, 403);
  });

  it('keeps /healthz reachable whatever the Host', async () => {
    const res = await request(app, '/healthz', { headers: { Host: 'anything.example.com' } });
    assert.equal(res.status, 200);
  });
});

describe('Content-Security-Policy script-src', () => {
  it('allows exactly the pairing script hash on /pair/*', async () => {
    const res = await request(app, '/pair/does-not-exist');
    const csp = res.headers['content-security-policy'] ?? '';
    assert.ok(csp.includes(`script-src ${PAIRING_SCRIPT_CSP_SOURCE};`), csp);
    assert.match(csp, /default-src 'none'/);
  });

  it('has no script-src on the dashboard', async () => {
    const res = await request(app, '/');
    assert.doesNotMatch(res.headers['content-security-policy'] ?? '', /script-src/);
  });

  it('matches the hash of the inline script embedded in pairingPage output', () => {
    const html = pairingPage({ pairingId: 'p1', provider: 'Bank', items: [], budgetAccounts: [] });
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match, 'pairing page has an inline script');
    const hash = createHash('sha256').update(match[1]).digest('base64');
    assert.equal(PAIRING_SCRIPT_CSP_SOURCE, `'sha256-${hash}'`);
  });
});

describe('POST /budgets', () => {
  const sameOrigin = () => ({ Origin: `http://127.0.0.1:${serverAddress.port}` });
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const readBudgets = (): { id: string; name: string; syncId: string; encryptionPassword?: string }[] =>
    JSON.parse(fs.readFileSync(configFile, 'utf-8')).budgets;

  before(() => {
    fs.rmSync(configFile, { force: true });
  });

  it('rejects a cross-site Origin with 403 and writes nothing', async () => {
    const res = await request(app, '/budgets', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
      body: form({ name: 'Evil', syncId: 'sync-evil' }),
    });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(configFile), false);
  });

  it('returns 400 when the name or sync id is missing', async () => {
    for (const body of [form({ syncId: 'sync-x' }), form({ name: 'X' }), form({ name: ' ', syncId: '' })]) {
      const res = await request(app, '/budgets', { method: 'POST', headers: sameOrigin(), body });
      assert.equal(res.status, 400, body);
    }
    assert.equal(fs.existsSync(configFile), false);
  });

  it('adds a budget and redirects to the dashboard without a pairingId', async () => {
    const res = await request(app, '/budgets', {
      method: 'POST',
      headers: sameOrigin(),
      body: form({ name: 'Joint', syncId: 'sync-joint', encryptionPassword: 'pw' }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/?msg=' + encodeURIComponent('Added budget "Joint".'));
    const budgets = readBudgets();
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].syncId, 'sync-joint');
    assert.equal(budgets[0].encryptionPassword, 'pw');
    assert.match(budgets[0].id, /^budget_[0-9a-f]{12}$/);
  });

  it('redirects back to the pairing page after adding when a pairingId is given', async () => {
    const res = await request(app, '/budgets', {
      method: 'POST',
      headers: sameOrigin(),
      body: form({ name: 'Savings', syncId: 'sync-savings', pairingId: 'pair 1' }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/pair/pair%201');
    assert.equal(readBudgets().length, 2);
  });

  it('redirects a duplicate sync id back to /pair/<id>?err=<message> when a pairingId is given', async () => {
    const before = fs.readFileSync(configFile, 'utf-8');
    const res = await request(app, '/budgets', {
      method: 'POST',
      headers: sameOrigin(),
      body: form({ name: 'Again', syncId: 'sync-joint', pairingId: 'pair1' }),
    });
    assert.equal(res.status, 302);
    const location = res.headers.location ?? '';
    assert.ok(location.startsWith('/pair/pair1?err='), location);
    const err = decodeURIComponent(location.slice('/pair/pair1?err='.length));
    assert.match(err, /Sync ID sync-joint is already used by budget "Joint"/);
    assert.equal(fs.readFileSync(configFile, 'utf-8'), before);
  });

  it('returns 400 for a duplicate sync id without a pairingId', async () => {
    const res = await request(app, '/budgets', {
      method: 'POST',
      headers: sameOrigin(),
      body: form({ name: 'Again', syncId: 'sync-joint' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /already used by budget/);
    assert.equal(readBudgets().length, 2);
  });
});

describe('GET /pair/:id warning banner', () => {
  const writeBudgets = (budgets: { id: string; name: string; syncId: string }[]) =>
    fs.writeFileSync(configFile, JSON.stringify({ budgets, accounts: [], createdAt: '2026-01-01T00:00:00Z' }));
  const distinct = [
    { id: 'budget_a', name: 'Alpha', syncId: 'sync-a' },
    { id: 'budget_b', name: 'Beta', syncId: 'sync-b' },
  ];
  const shared = [
    { id: 'budget_a', name: 'Alpha', syncId: 'sync-same' },
    { id: 'budget_b', name: 'Beta', syncId: 'sync-same' },
  ];
  const newSession = (warning?: string) =>
    setPairing({ connectionId: 'conn_1', mode: 'new', provider: 'test', items: [], warning });
  const banner = (body: string) => body.match(/<div class="error">([\s\S]*?)<\/div>/)?.[1];

  before(() => {
    writeBudgets(distinct);
  });
  after(() => {
    fs.rmSync(configFile, { force: true });
  });

  it('shows the session warning', async () => {
    writeBudgets(distinct);
    const res = await request(app, `/pair/${newSession('Config was unreadable')}`);
    assert.equal(res.status, 200);
    assert.equal(banner(res.body), 'Config was unreadable');
  });

  it('shows the duplicate sync id warning when two budgets share a sync id', async () => {
    writeBudgets(shared);
    const res = await request(app, `/pair/${newSession()}`);
    assert.equal(res.status, 200);
    assert.match(banner(res.body) ?? '', /Budgets &quot;Alpha&quot; and &quot;Beta&quot; share the same sync ID/);
  });

  it('shows the escaped ?err= message', async () => {
    writeBudgets(distinct);
    const res = await request(app, `/pair/${newSession()}?err=${encodeURIComponent('<b>bad</b>')}`);
    assert.equal(banner(res.body), '&lt;b&gt;bad&lt;/b&gt;');
    assert.ok(!res.body.includes('<b>bad</b>'));
  });

  it('joins all three warnings with a space', async () => {
    writeBudgets(shared);
    const res = await request(app, `/pair/${newSession('Session warn')}?err=${encodeURIComponent('Query err')}`);
    const text = banner(res.body) ?? '';
    assert.ok(text.startsWith('Session warn Budgets '));
    assert.ok(text.endsWith(' Query err'));
    assert.match(text, /share the same sync ID/);
  });

  it('shows no warning banner when there is nothing to warn about', async () => {
    writeBudgets(distinct);
    const res = await request(app, `/pair/${newSession()}`);
    assert.equal(res.status, 200);
    assert.equal(banner(res.body), undefined);
  });

  it('returns 404 for an unknown pairing id', async () => {
    const res = await request(app, '/pair/doesnotexist');
    assert.equal(res.status, 404);
    assert.match(res.body, /Pairing session expired/);
  });
});

describe('edit pairings routes', () => {
  const sameOrigin = () => ({ Origin: `http://127.0.0.1:${serverAddress.port}` });
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const future = () => new Date(Date.now() + 3600_000).toISOString();
  const budgets = [
    { id: 'b1', name: 'Personal', syncId: 's1' },
    { id: 'b2', name: 'Joint', syncId: 's2' },
  ];
  const acct = (over: Record<string, unknown>) => ({
    name: 'Current',
    connectionId: 'conn_edit',
    budgetId: 'b1',
    accountKind: 'account',
    truelayerAccountId: 'tl1',
    actualAccountId: 'a1',
    currency: 'GBP',
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
  const writeConfig = (accounts: unknown[], b: unknown[] = budgets) =>
    fs.writeFileSync(configFile, JSON.stringify({ budgets: b, accounts, createdAt: '2026-01-01T00:00:00Z' }));
  const readAccounts = (): Record<string, unknown>[] =>
    JSON.parse(fs.readFileSync(configFile, 'utf-8')).accounts;
  const post = (id: string, fields: Record<string, string>) =>
    request(app, `/connections/${id}/pairings`, {
      method: 'POST',
      headers: sameOrigin(),
      body: form(fields),
    });

  let truelayerDown = false;
  const tlAccounts = [
    { account_id: 'tl1', display_name: 'Current', currency: 'GBP' },
    { account_id: 'tl2', display_name: 'Savings <b>', currency: 'GBP' },
  ];
  const tlCards = [{ account_id: 'tc1', display_name: 'Visa', currency: 'GBP' }];

  before(() => {
    actualAccountsBySync['s1'] = [
      { id: 'a1', name: 'Main', offbudget: false, closed: false },
      { id: 'a2', name: 'Bills', offbudget: false, closed: false },
    ];
    actualAccountsBySync['s2'] = [{ id: 'c1', name: 'Shared', offbudget: false, closed: false }];
    saveConnection('conn_edit', {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: future(),
      providerDisplayName: 'Edit <Bank>',
    });
    saveConnection('conn_other', {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: future(),
      providerDisplayName: 'Other',
    });
    saveConnection('conn_lapsed', {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: future(),
      needsReauth: true,
      providerDisplayName: 'Lapsed',
    });
    mock.method(axios, 'get', async (url: string) => {
      if (truelayerDown) throw new Error('TrueLayer unreachable');
      if (url.endsWith('/data/v1/accounts')) return { data: { results: tlAccounts } };
      if (url.endsWith('/data/v1/cards')) return { data: { results: tlCards } };
      throw new Error(`unexpected GET ${url}`);
    });
  });

  beforeEach(() => {
    truelayerDown = false;
    writeConfig([
      acct({}),
      acct({ connectionId: 'conn_other', truelayerAccountId: 'tl1', actualAccountId: 'a2', name: 'Other acct' }),
    ]);
  });

  after(() => {
    mock.restoreAll();
    fs.rmSync(configFile, { force: true });
  });

  it('GET 404s for an unknown connection and carries the pairing-script CSP hash', async () => {
    assert.equal((await request(app, '/connections/nope/pairings')).status, 404);
    const res = await request(app, '/connections/conn_edit/pairings');
    assert.equal(res.status, 200);
    assert.ok((res.headers['content-security-policy'] ?? '').includes(PAIRING_SCRIPT_CSP_SOURCE));
  });

  it('GET lists live accounts and cards with the saved pairing preselected, and escapes names', async () => {
    const res = await request(app, '/connections/conn_edit/pairings');
    assert.match(res.body, /name="map_tl1"/);
    assert.match(res.body, /name="map_tl2"/);
    assert.match(res.body, /name="map_tc1"/);
    assert.match(res.body, /value="a1" data-budget="b1" selected/);
    assert.match(res.body, /value="b1" selected/);
    assert.ok(res.body.includes('Savings &lt;b&gt;'));
    assert.equal(res.body.includes('Savings <b>'), false);
    assert.ok(res.body.includes('Edit &lt;Bank&gt;'));
    assert.doesNotMatch(res.body, /Showing saved pairings only/);
  });

  it('GET falls back to saved mappings when consent has lapsed', async () => {
    writeConfig([acct({ connectionId: 'conn_lapsed', name: 'Saved only' })]);
    const res = await request(app, '/connections/conn_lapsed/pairings');
    assert.equal(res.status, 200);
    assert.match(res.body, /needs reconnecting/);
    assert.match(res.body, /Saved only/);
    assert.doesNotMatch(res.body, /name="map_tc1"/);
  });

  it('GET falls back to saved mappings when TrueLayer is unreachable', async () => {
    truelayerDown = true;
    const res = await request(app, '/connections/conn_edit/pairings');
    assert.equal(res.status, 200);
    assert.match(res.body, /Could not load accounts from TrueLayer/);
    assert.match(res.body, /name="map_tl1"/);
    assert.doesNotMatch(res.body, /name="map_tl2"/);
  });

  it('GET works when config.json does not exist', async () => {
    fs.rmSync(configFile, { force: true });
    const res = await request(app, '/connections/conn_edit/pairings');
    assert.equal(res.status, 200);
    assert.match(res.body, /— do not sync —/);
  });

  it('POST rejects a cross-site Origin and writes nothing', async () => {
    const before = fs.readFileSync(configFile, 'utf-8');
    const res = await request(app, '/connections/conn_edit/pairings', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
      body: form({ map_tl1: 'a2', budget_tl1: 'b1' }),
    });
    assert.equal(res.status, 403);
    assert.equal(fs.readFileSync(configFile, 'utf-8'), before);
  });

  it('POST 404s for an unknown connection', async () => {
    assert.equal((await post('nope', { map_tl1: 'a1', budget_tl1: 'b1' })).status, 404);
  });

  it('POST with unchanged selections is a no-op that keeps lastSyncedAt', async () => {
    const before = fs.readFileSync(configFile, 'utf-8');
    const res = await post('conn_edit', { map_tl1: 'a1', budget_tl1: 'b1', map_tl2: '', budget_tl2: 'b1' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location ?? '', /\/connections\/conn_edit\/pairings\?msg=Updated%200%20pairing/);
    assert.equal(fs.readFileSync(configFile, 'utf-8'), before);
  });

  it('POST re-points a mapping to another budget/account, leaving other connections alone', async () => {
    const res = await post('conn_edit', { map_tl1: 'c1', budget_tl1: 'b2' });
    assert.equal(res.status, 302);
    const accounts = readAccounts();
    const mine = accounts.find((a) => a.connectionId === 'conn_edit')!;
    assert.equal(mine.actualAccountId, 'c1');
    assert.equal(mine.budgetId, 'b2');
    assert.equal(mine.lastSyncedAt, '2026-01-01T00:00:00.000Z');
    const other = accounts.find((a) => a.connectionId === 'conn_other')!;
    assert.equal(other.actualAccountId, 'a2');
    assert.equal(other.budgetId, 'b1');
  });

  it('POST removes a mapping when the account is blank, only on the edited connection', async () => {
    const res = await post('conn_edit', { map_tl1: '', budget_tl1: 'b1' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location ?? '', /removed%201/);
    const accounts = readAccounts();
    assert.deepEqual(accounts.map((a) => a.connectionId), ['conn_other']);
  });

  it('POST cannot touch another connection by posting its account id', async () => {
    // conn_other also maps tl1; editing conn_edit must not change that one.
    await post('conn_edit', { map_tl1: '' });
    assert.equal(readAccounts().filter((a) => a.connectionId === 'conn_other').length, 1);
    await post('conn_lapsed', { map_tl1: '', map_tl2: 'a1', budget_tl2: 'b1' });
    assert.equal(readAccounts().filter((a) => a.connectionId === 'conn_other').length, 1);
  });

  it('POST pairs a previously skipped account using TrueLayer data, not form fields', async () => {
    const res = await post('conn_edit', {
      map_tl1: 'a1',
      budget_tl1: 'b1',
      map_tc1: 'a2',
      budget_tc1: 'b1',
      name_tc1: 'FORGED',
      kind_tc1: 'account',
      currency_tc1: 'USD',
    });
    assert.equal(res.status, 302);
    const added = readAccounts().find((a) => a.truelayerAccountId === 'tc1')!;
    assert.equal(added.connectionId, 'conn_edit');
    assert.equal(added.name, 'Visa');
    assert.equal(added.accountKind, 'card');
    assert.equal(added.currency, 'GBP');
    assert.equal(added.actualAccountId, 'a2');
  });

  it('POST ignores accounts TrueLayer does not report and unknown budgets', async () => {
    const res = await post('conn_edit', {
      map_ghost: 'a1',
      budget_ghost: 'b1',
      map_tl1: 'a2',
      budget_tl1: 'no_such_budget',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.location ?? '', /ignored%202/);
    const accounts = readAccounts();
    assert.equal(accounts.some((a) => a.truelayerAccountId === 'ghost'), false);
    assert.equal(accounts.find((a) => a.connectionId === 'conn_edit')!.actualAccountId, 'a1');
  });

  it('POST cannot add skipped accounts when TrueLayer is unreachable, but can still remove', async () => {
    truelayerDown = true;
    await post('conn_edit', { map_tl2: 'a1', budget_tl2: 'b1', map_tl1: '' });
    const accounts = readAccounts();
    assert.equal(accounts.some((a) => a.truelayerAccountId === 'tl2'), false);
    assert.equal(accounts.some((a) => a.connectionId === 'conn_edit'), false);
  });

  it('POST survives hostile prototype-ish account ids', async () => {
    const res = await post('conn_edit', { 'map___proto__': 'a1', budget___proto__: 'b1', map_constructor: '' });
    assert.equal(res.status, 302);
    assert.equal(readAccounts().length, 2);
  });

  it('concurrent POSTs on different connections both land', async () => {
    writeConfig([
      acct({}),
      acct({ connectionId: 'conn_other', truelayerAccountId: 'tl9', actualAccountId: 'a2' }),
    ]);
    await Promise.all([
      post('conn_edit', { map_tl1: 'a2', budget_tl1: 'b1' }),
      post('conn_other', { map_tl9: 'a1', budget_tl9: 'b1' }),
    ]);
    const accounts = readAccounts();
    assert.equal(accounts.find((a) => a.connectionId === 'conn_edit')!.actualAccountId, 'a2');
    assert.equal(accounts.find((a) => a.connectionId === 'conn_other')!.actualAccountId, 'a1');
  });
});
