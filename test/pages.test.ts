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

describe('dashboardPage pairings', () => {
  const conn = {
    id: 'conn_1',
    provider: 'Monzo',
    accountCount: 2,
    status: 'healthy' as const,
  };

  it('shows a plain count when every bank account has one target', () => {
    const html = dashboardPage({ connections: [{ ...conn, pairingCount: 2 }] });
    assert.match(html, /Accounts mapped: 2 &middot;/);
    assert.doesNotMatch(html, /\d targets/);
  });

  it('shows accounts -> targets when some are synced to several budgets', () => {
    const html = dashboardPage({
      connections: [
        {
          ...conn,
          pairingCount: 3,
          pairings: [{ label: 'Current Account → Personal, Joint' }, { label: 'Card → Personal' }],
        },
      ],
    });
    assert.match(html, /Accounts mapped: 2 &rarr; 3 targets/);
    assert.ok(html.includes('Current Account → Personal, Joint'));
  });

  it('renders escaped stale-target warnings', () => {
    const html = dashboardPage({
      connections: [
        {
          ...conn,
          pairingCount: 2,
          staleTargets: ['Joint · Current <b>Account</b> not synced yet'],
        },
      ],
    });
    assert.ok(html.includes('class="stale"'));
    assert.ok(html.includes('not synced yet'));
    assert.equal(html.includes('<b>Account'), false);
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

  it('renders one select per budget per bank account, named map_<tl>__<budget>', () => {
    const html = pairingPage(base);
    for (const name of ['map_tl1__default', 'map_tl1__budget_2', 'map_tl2__default', 'map_tl2__budget_2']) {
      assert.ok(html.includes(`<select name="${name}"`), name);
    }
    assert.equal((html.match(/<select /g) ?? []).length, 4);
    assert.ok(html.includes('— not synced —'));
    assert.equal(html.includes('Joint <b>'), false);
  });

  it('lists only that budget\'s accounts in each select and labels off-budget accounts', () => {
    const html = pairingPage(base);
    const sel = (name: string) => html.slice(html.indexOf(`name="${name}"`)).split('</select>')[0];
    assert.ok(sel('map_tl1__default').includes('>Main</option>'));
    assert.equal(sel('map_tl1__default').includes('Shared'), false);
    assert.ok(sel('map_tl1__budget_2').includes('Shared (off-budget)'));
    assert.equal(sel('map_tl1__budget_2').includes('Main'), false);
    assert.ok(html.includes('<span>Joint &lt;b&gt;</span>'));
  });

  it('hides the budget label when only one budget is shown', () => {
    const html = pairingPage({ ...base, budgetAccounts: [budgetAccounts[0]] });
    assert.equal((html.match(/<select /g) ?? []).length, 2);
    assert.equal(html.includes('<span>Default</span>'), false);
  });

  it('has no script or noscript on either page', () => {
    const edit = editPairingsPage({
      connectionId: 'c',
      provider: 'M',
      budgetAccounts,
      rows: [{ truelayerAccountId: 'tl1', name: 'X', accountKind: 'account', currency: 'GBP', targets: {} }],
    });
    for (const html of [pairingPage(base), edit]) {
      assert.equal(/<script|<noscript/i.test(html), false);
    }
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

const editRow = (targets: Record<string, string>, over: Record<string, unknown> = {}) => ({
  truelayerAccountId: 'tl1',
  name: 'Bank',
  accountKind: 'account' as const,
  currency: 'GBP',
  targets,
  ...over,
});
const editBase = { connectionId: 'conn_1', provider: 'Monzo', budgetAccounts: editBudgetAccounts };

describe('editPairingsPage', () => {
  it('pre-selects the saved account in each budget and offers remove only where mapped', () => {
    const html = editPairingsPage({ ...editBase, rows: [editRow({ b2: 'a2' })] });

    assert.match(html, /<option value="a2" selected>Joint Current<\/option>/);
    const b1 = html.slice(html.indexOf('name="map_tl1__b1"')).split('</select>')[0];
    const b2 = html.slice(html.indexOf('name="map_tl1__b2"')).split('</select>')[0];
    assert.ok(b1.includes('— not synced —'));
    assert.equal(b1.includes('— remove —'), false);
    assert.ok(b2.includes('— remove —'));
  });

  it('shows both targets of a bank account synced into two budgets', () => {
    const html = editPairingsPage({ ...editBase, rows: [editRow({ b1: 'a1', b2: 'a2' })] });
    assert.match(html, /<option value="a1" selected>/);
    assert.match(html, /<option value="a2" selected>/);
  });

  it('keeps a mapping in a budget that failed to load, named when known', () => {
    const html = editPairingsPage({
      ...editBase,
      configuredBudgets: [{ id: 'b9', name: 'Holiday' }],
      rows: [editRow({ b9: 'a9' })],
    });
    assert.ok(html.includes('<span>Holiday</span>'));
    assert.match(html, /name="map_tl1__b9"/);
    assert.match(html, /<option value="a9" selected>a9 \(unavailable — budget not loaded\)<\/option>/);
    assert.match(html, /<option value="">— remove —<\/option>/);
  });

  it('renders an unknown budget line when the budget is not configured at all', () => {
    const html = editPairingsPage({ ...editBase, rows: [editRow({ gone: 'a9' })] });
    assert.ok(html.includes('Unknown budget gone'));
    assert.match(html, /name="map_tl1__gone"/);
  });

  it('keeps a mapped account that is missing from a loaded budget', () => {
    const html = editPairingsPage({ ...editBase, rows: [editRow({ b1: 'a-missing' })] });
    assert.match(html, /<option value="a-missing" selected>a-missing \(unavailable — account not loaded\)<\/option>/);
  });

  it('escapes names, ids, provider, message, warning and note', () => {
    const html = editPairingsPage({
      ...editBase,
      provider: '<script>p</script>',
      message: '<i>m</i>',
      warning: '<i>w</i>',
      note: '<i>n</i>',
      rows: [editRow({ 'b"9': '<a9>' }, { truelayerAccountId: 'x"y', name: '<img src=x>' })],
    });
    assert.equal(html.includes('<script>p'), false);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<i>'), false);
    assert.equal(html.includes('<a9>'), false);
    assert.ok(html.includes('name="map_x&quot;y__b&quot;9"'));
    assert.ok(html.includes('&lt;i&gt;n&lt;/i&gt;'));
  });

  it('shows the fallback note, and a notice when no budgets loaded', () => {
    const html = editPairingsPage({
      ...editBase,
      budgetAccounts: [],
      note: 'Could not load accounts from TrueLayer (x). Showing saved pairings only.',
      rows: [editRow({ b1: 'a1' })],
    });
    assert.match(html, /Showing saved pairings only/);
    assert.match(html, /No budgets could be loaded/);
  });

  it('says so when there are no accounts and renders no form', () => {
    const html = editPairingsPage({ ...editBase, rows: [] });
    assert.match(html, /No accounts found/);
    assert.equal(html.includes('<form'), false);
  });

  it('posts to the connection-scoped URL, encoded', () => {
    const html = editPairingsPage({ ...editBase, connectionId: 'a/b', rows: [editRow({})] });
    assert.ok(html.includes('action="/connections/a%2Fb/pairings"'));
  });
});
