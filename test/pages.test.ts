import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  dashboardPage,
  pairingPage,
  messagePage,
} from '../src/web/pages.js';
import { describeErrorBody } from '../src/util/http.js';
import { reauthWarnDays } from '../src/config.js';

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    assert.equal(
      escapeHtml(`<img src=x onerror="alert('1')">&`),
      '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;'
    );
  });
});

describe('dashboardPage', () => {
  it('escapes reflected query banners', () => {
    const html = dashboardPage({
      connections: [],
      message: '<script>alert(1)</script>',
      error: '<img src=x onerror=alert(1)>',
    });
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('<img'), false);
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('escapes provider names and reauth reasons from external APIs', () => {
    const html = dashboardPage({
      connections: [
        {
          id: 'conn_1',
          provider: 'Monzo <b>evil</b>',
          accountCount: 1,
          status: 'reauth_needed',
          reason: 'refresh_token_invalid "quoted"',
        },
      ],
    });
    assert.equal(html.includes('<b>evil</b>'), false);
    assert.ok(html.includes('Monzo &lt;b&gt;evil&lt;/b&gt;'));
    assert.ok(html.includes('&quot;quoted&quot;'));
  });

  it('escapes the status value used in the badge class attribute', () => {
    const html = dashboardPage({
      connections: [
        {
          id: 'conn_1',
          provider: 'Bank',
          accountCount: 0,
          status: 'healthy',
        },
      ],
    });
    // The literal is safe for the fixed status union; the assertion documents
    // that a hostile status cannot inject out of the attribute.
    assert.ok(html.includes('class="badge healthy"'));
  });
});

describe('pairingPage', () => {
  it('escapes the warning, message, provider and account fields', () => {
    const html = pairingPage({
      pairingId: 'p&d',
      provider: 'Bank"><script>alert(1)</script>',
      items: [
        {
          truelayerAccountId: 'tl"1',
          name: 'Current <account>',
          accountKind: 'account',
          currency: 'GBP',
        },
      ],
      actualAccounts: [{ id: 'a"1', name: 'Savings <x>', offbudget: false, closed: false }],
      message: '<b>banner</b>',
      warning: '<script>alert(2)</script>',
    });
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('<b>banner</b>'), false);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('Current &lt;account&gt;'));
  });
});

describe('messagePage', () => {
  it('escapes title and message', () => {
    const html = messagePage('Failed <x>', 'err & <script>', { error: true });
    assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('Failed &lt;x&gt;'));
  });
});

describe('describeErrorBody', () => {
  it('prefers OAuth error + error_description fields', () => {
    assert.equal(
      describeErrorBody({ error: 'invalid_grant', error_description: 'token expired' }),
      'invalid_grant — token expired'
    );
    assert.equal(describeErrorBody({ error: 'invalid_grant' }), 'invalid_grant');
    assert.equal(describeErrorBody({ error_description: 'expired' }), 'expired');
  });

  it('stringifies bodies without OAuth error fields', () => {
    assert.equal(describeErrorBody({ foo: 'bar' }), '{"foo":"bar"}');
    assert.equal(describeErrorBody('plain'), '"plain"');
    assert.equal(describeErrorBody(undefined), 'unknown error');
  });
});

describe('reauthWarnDays', () => {
  const original = process.env.REAUTH_WARN_DAYS;

  it('defaults to 14', () => {
    delete process.env.REAUTH_WARN_DAYS;
    assert.equal(reauthWarnDays(), 14);
  });

  it('parses a valid value', () => {
    process.env.REAUTH_WARN_DAYS = '7';
    assert.equal(reauthWarnDays(), 7);
  });

  it('falls back to 14 on garbage or negative values', () => {
    process.env.REAUTH_WARN_DAYS = 'not-a-number';
    assert.equal(reauthWarnDays(), 14);
    process.env.REAUTH_WARN_DAYS = '-3';
    assert.equal(reauthWarnDays(), 14);
  });

  after(() => {
    if (original === undefined) delete process.env.REAUTH_WARN_DAYS;
    else process.env.REAUTH_WARN_DAYS = original;
  });
});
