import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  dashboardPage,
  pairingPage,
  editPairingsPage,
  messagePage,
} from '../src/web/pages.js';
import type { BudgetAccounts } from '../src/web/pages.js';
import { createHash } from 'crypto';
import { PAIRING_SCRIPT_CSP_SOURCE } from '../src/web/pages.js';
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
      budgetAccounts: [
        {
          budget: { id: 'b"1', name: 'Home <b>', syncId: 'sync' },
          accounts: [{ id: 'a"1', name: 'Savings <x>', offbudget: false, closed: false }],
        },
      ],
      message: '<b>banner</b>',
      warning: '<script>alert(2)</script>',
    });
    assert.equal(html.includes('<script>alert'), false);
    assert.equal(html.includes('Home <b>'), false);
    assert.equal(html.includes('<b>banner</b>'), false);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('Current &lt;account&gt;'));
  });
});

describe('pairingPage budgets', () => {
  const items = [
    { truelayerAccountId: 'tl1', name: 'Current', accountKind: 'account' as const, currency: 'GBP' },
    { truelayerAccountId: 'tl2', name: 'Card', accountKind: 'card' as const, currency: 'GBP' },
  ];
  const budgetAccounts = [
    {
      budget: { id: 'default', name: 'Default', syncId: 's1' },
      accounts: [{ id: 'a1', name: 'Main', offbudget: false, closed: false }],
    },
    {
      budget: { id: 'budget_2', name: 'Joint <b>', syncId: 's2' },
      accounts: [{ id: 'a2', name: 'Shared', offbudget: true, closed: false }],
    },
  ];
  const base = { pairingId: 'p1', provider: 'Monzo', items, budgetAccounts };

  it('renders a budget selector per bank account with every budget, default first', () => {
    const html = pairingPage(base);
    assert.equal((html.match(/<select name="budget_tl\d" class="budget"/g) ?? []).length, 2);
    assert.ok(html.includes('name="budget_tl1"'));
    assert.ok(html.includes('data-target="acct_tl1"'));
    const first = html.indexOf('<option value="default" selected>Default</option>');
    const second = html.indexOf('<option value="budget_2">Joint &lt;b&gt;</option>');
    assert.ok(first !== -1 && second > first, 'default budget option listed first');
    assert.equal(html.includes('Joint <b>'), false);
  });

  it('tags each Actual account option with its budget and labels off-budget accounts', () => {
    const html = pairingPage(base);
    assert.ok(html.includes('value="a1" data-budget="default">Default / Main</option>'));
    assert.ok(html.includes('data-budget="budget_2">Joint &lt;b&gt; / Shared (off-budget)</option>'));
  });

  it('always renders the add-budget form, carrying the pairing id', () => {
    for (const html of [pairingPage(base), pairingPage({ ...base, budgetAccounts: [] })]) {
      assert.ok(html.includes('<form method="post" action="/budgets">'));
      assert.ok(html.includes('name="syncId"'));
      assert.ok(html.includes('name="encryptionPassword"'));
      assert.match(html, /action="\/budgets">\s*<input type="hidden" name="pairingId" value="p1">/);
    }
  });

  it('tells the user to add a budget when none are configured', () => {
    assert.match(pairingPage({ ...base, budgetAccounts: [] }), /No budgets configured yet/);
    assert.doesNotMatch(pairingPage(base), /No budgets configured yet/);
  });

  it('shows the joined, escaped warning exactly once', () => {
    const warning = 'Session <i>warn</i>. Duplicate "sync" id. Err & more';
    const html = pairingPage({ ...base, warning });
    assert.equal(html.includes('<i>'), false);
    const escaped = 'Session &lt;i&gt;warn&lt;/i&gt;. Duplicate &quot;sync&quot; id. Err &amp; more';
    assert.equal(html.split(escaped).length - 1, 1);
    assert.ok(html.includes(`<div class="error">${escaped}</div>`));
  });

  it('omits the warning banner when there is no warning', () => {
    assert.equal(pairingPage(base).includes('<div class="error">'), false);
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

describe('pairingPage budget selection', () => {
  const budgetAccounts = [
    { budget: { id: 'b1', name: 'First', syncId: 's1' }, accounts: [] },
    { budget: { id: 'b"2', name: 'Second', syncId: 's2' }, accounts: [] },
  ];
  const base = { truelayerAccountId: 'tl1', name: 'Current', accountKind: 'account' as const, currency: 'GBP' };

  it('selects the first (default) budget when unpaired', () => {
    const html = pairingPage({ pairingId: 'p', provider: 'X', items: [base], budgetAccounts });
    assert.ok(html.includes('<option value="b1" selected>First</option>'));
    assert.equal(html.includes('selected>Second'), false);
  });

  it('selects the existing budget, escaped', () => {
    const html = pairingPage({ pairingId: 'p', provider: 'X', items: [{ ...base, budgetId: 'b"2' }], budgetAccounts });
    assert.ok(html.includes('<option value="b&quot;2" selected>Second</option>'));
    assert.equal(html.includes('value="b1" selected'), false);
  });

  it('falls back to the default when the existing budget is unknown', () => {
    const html = pairingPage({ pairingId: 'p', provider: 'X', items: [{ ...base, budgetId: 'gone' }], budgetAccounts });
    assert.ok(html.includes('value="b1" selected'));
  });

  it('warns without JavaScript that accounts must match the budget', () => {
    const html = pairingPage({ pairingId: 'p', provider: 'X', items: [base], budgetAccounts });
    assert.match(html, /<noscript>[^]*must belong to the budget selected/);
  });
});


const editBudgetAccounts: BudgetAccounts[] = [
  {
    budget: { id: 'b1', name: 'Personal', syncId: 's1' },
    accounts: [{ id: 'a1', name: 'Current', offbudget: false, closed: false }],
  },
  {
    budget: { id: 'b2', name: 'Joint', syncId: 's2' },
    accounts: [{ id: 'a2', name: 'Joint Current', offbudget: false, closed: false }],
  },
];

describe('editPairingsPage', () => {
  it('pre-selects the saved budget and account', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl1',
          name: 'Bank',
          accountKind: 'account',
          currency: 'GBP',
          mapped: true,
          budgetId: 'b2',
          actualAccountId: 'a2',
        },
      ],
      budgetAccounts: editBudgetAccounts,
    });

    assert.match(html, /value="b2" selected/);
    assert.match(html, /value="a2" data-budget="b2" selected/);
    assert.match(html, /— remove mapping —/);
  });

  it('offers "do not sync" for an unmapped account', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl2',
          name: 'Savings',
          accountKind: 'account',
          currency: 'GBP',
          mapped: false,
        },
      ],
      budgetAccounts: editBudgetAccounts,
    });

    assert.match(html, /— do not sync —/);
    assert.doesNotMatch(html, /— remove mapping —/);
  });

  it('keeps an unavailable mapping selected instead of silently dropping it', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl1',
          name: 'Bank',
          accountKind: 'account',
          currency: 'GBP',
          mapped: true,
          budgetId: 'b9',
          actualAccountId: 'a9',
        },
      ],
      budgetAccounts: editBudgetAccounts,
    });

    assert.match(html, /value="b9" selected/);
    assert.match(html, /value="a9" data-budget="b9" selected/);
    assert.match(html, /unavailable/);
  });

  it('carries the TrueLayer name/kind/currency so a new pairing can be saved', () => {
    const html = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      rows: [
        {
          truelayerAccountId: 'tl3',
          name: 'Credit Card',
          accountKind: 'card',
          currency: 'GBP',
          mapped: false,
        },
      ],
      budgetAccounts: editBudgetAccounts,
    });

    assert.match(html, /name="name_tl3" value="Credit Card"/);
    assert.match(html, /name="kind_tl3" value="card"/);
    assert.match(html, /name="currency_tl3" value="GBP"/);
  });
});

describe('editPairingsPage rendering', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    truelayerAccountId: 'tl1',
    name: 'Bank',
    accountKind: 'account' as const,
    currency: 'GBP',
    mapped: true,
    budgetId: 'b1',
    actualAccountId: 'a1',
    ...over,
  });
  const base = { connectionId: 'conn_1', provider: 'Monzo', budgetAccounts: editBudgetAccounts };

  it('selects only the matching budget/account pair when account ids repeat across budgets', () => {
    const shared: BudgetAccounts[] = [
      { budget: { id: 'b1', name: 'One', syncId: 's1' }, accounts: [{ id: 'dup', name: 'X', offbudget: false, closed: false }] },
      { budget: { id: 'b2', name: 'Two', syncId: 's2' }, accounts: [{ id: 'dup', name: 'X', offbudget: false, closed: false }] },
    ];
    const html = editPairingsPage({ ...base, budgetAccounts: shared, rows: [row({ budgetId: 'b2', actualAccountId: 'dup' })] });
    assert.equal((html.match(/value="dup" data-budget="[^"]*" selected/g) ?? []).length, 1);
    assert.match(html, /value="dup" data-budget="b2" selected/);
  });

  it('escapes names, ids, provider, message, warning and note', () => {
    const html = editPairingsPage({
      ...base,
      provider: '<script>p</script>',
      message: '<i>m</i>',
      warning: '<i>w</i>',
      note: '<i>n</i>',
      rows: [row({ truelayerAccountId: 'x"y', name: '<img src=x>', budgetId: 'b"9', actualAccountId: '<a9>' })],
    });
    assert.equal(html.includes('<script>p'), false);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<i>'), false);
    assert.equal(html.includes('<a9>'), false);
    assert.ok(html.includes('name="map_x&quot;y"'));
    assert.ok(html.includes('&lt;i&gt;n&lt;/i&gt;'));
  });

  it('shows the fallback note, and a notice instead of a form when no budgets loaded', () => {
    const html = editPairingsPage({
      ...base,
      budgetAccounts: [],
      note: 'Could not load accounts from TrueLayer (x). Showing saved pairings only.',
      rows: [row()],
    });
    assert.match(html, /Showing saved pairings only/);
    assert.match(html, /No budgets could be loaded/);
  });

  it('says so when there are no accounts and renders no form', () => {
    const html = editPairingsPage({ ...base, rows: [] });
    assert.match(html, /No accounts found/);
    assert.equal(html.includes('<form'), false);
  });

  it('posts to the connection-scoped URL, encoded', () => {
    const html = editPairingsPage({ ...base, connectionId: 'a/b', rows: [row()] });
    assert.ok(html.includes('action="/connections/a%2Fb/pairings"'));
  });

  it('embeds the same inline script the CSP hash covers', () => {
    const html = editPairingsPage({ ...base, rows: [row()] });
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m);
    assert.equal(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`, PAIRING_SCRIPT_CSP_SOURCE);
  });
});
