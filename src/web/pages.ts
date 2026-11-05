import type { ActualAccount } from '../clients/actual.js';
import type { Budget } from '../config.js';
import type { PairingItem } from './oauth.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
  h1, h2 { line-height: 1.2; }
  .conn { border: 1px solid #8884; border-radius: 10px; padding: 16px; margin: 12px 0; }
  .conn-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .badge { padding: 2px 10px; border-radius: 999px; font-size: 0.8em; font-weight: 600; }
  .badge.healthy { background: #16a34a33; color: #16a34a; }
  .badge.expiring { background: #f59e0b33; color: #b45309; }
  .badge.reauth_needed { background: #dc262633; color: #dc2626; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #8886; background: #8881; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: white; }
  button.danger { background: transparent; border-color: #dc2626; color: #dc2626; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid #8884; }
  select { font: inherit; padding: 4px; max-width: 100%; }
  .targets { display: grid; gap: 6px; }
  .target { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .target > span { min-width: 7em; }
  .stale { color: #b45309; font-size: 0.9em; }
  .pairings { list-style: none; margin: 4px 0; padding: 0; }
  .banner { padding: 10px 14px; border-radius: 8px; background: #2563eb22; margin-bottom: 16px; }
  .error { padding: 10px 14px; border-radius: 8px; background: #dc262622; margin-bottom: 16px; }
  code { background: #8882; padding: 2px 5px; border-radius: 4px; }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function messagePage(
  title: string,
  message: string,
  opts: { error?: boolean; link?: boolean } = {}
): string {
  const cls = opts.error ? 'error' : 'banner';
  const back = opts.link === false ? '' : '<p><a href="/">Back to dashboard</a></p>';
  return layout(
    title,
    `<h1>${escapeHtml(title)}</h1>
     <div class="${cls}">${escapeHtml(message)}</div>
     ${back}`
  );
}

export function confirmDeletePage(connectionId: string, providerName: string): string {
  return layout(
    'Delete connection',
    `<h1>Delete connection</h1>
     <div class="error">
       This will delete the <strong>${escapeHtml(providerName)}</strong> connection
       (<code>${escapeHtml(connectionId)}</code>) and remove any accounts mapped to it. This cannot be undone.
     </div>
     <form method="post" action="/connections/${encodeURIComponent(connectionId)}/delete">
       <button class="danger" type="submit">Yes, delete</button>
     </form>
     <p><a href="/">Back to dashboard</a></p>`
  );
}

export type ConnectionStatus = 'healthy' | 'expiring' | 'reauth_needed';

export interface ConnectionView {
  id: string;
  provider: string;
  /** Distinct bank accounts with at least one mapping. */
  accountCount: number;
  /** Total mappings (bank account x budget). */
  pairingCount?: number;
  /** One summary line per bank account, e.g. "Current Account → Personal, Joint". */
  pairings?: { label: string }[];
  /** Mappings that have not synced recently, e.g. "Joint · Current Account last synced …". */
  staleTargets?: string[];
  lastSyncedAt?: string;
  consentExpiresAt?: string;
  daysLeft?: number;
  status: ConnectionStatus;
  reason?: string;
}

export interface DashboardData {
  connections: ConnectionView[];
  message?: string;
  error?: string;
}

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function dashboardPage(data: DashboardData): string {
  const banners = [
    data.message ? `<div class="banner">${escapeHtml(data.message)}</div>` : '',
    data.error ? `<div class="error">${escapeHtml(data.error)}</div>` : '',
  ].join('');

  const cards = data.connections
    .map((c) => {
      const expiry = c.consentExpiresAt
        ? `${formatDate(c.consentExpiresAt)}${c.daysLeft !== undefined ? ` (${c.daysLeft}d left)` : ''}`
        : 'unknown';
      const pairingCount = c.pairingCount ?? c.accountCount;
      const mappedText =
        pairingCount === c.accountCount
          ? `${c.accountCount}`
          : `${c.accountCount} &rarr; ${pairingCount} targets`;
      const pairingList = c.pairings?.length
        ? `<ul class="pairings muted">${c.pairings.map((p) => `<li>${escapeHtml(p.label)}</li>`).join('')}</ul>`
        : '';
      const stale = (c.staleTargets ?? [])
        .map((t) => `<div class="stale">${escapeHtml(t)}</div>`)
        .join('');
      const reason = c.reason ? `<div class="muted">Reason: ${escapeHtml(c.reason)}</div>` : '';
      return `<div class="conn">
        <div class="conn-header">
          <h2>${escapeHtml(c.provider)}</h2>
          <span class="badge ${escapeHtml(c.status)}">${escapeHtml(c.status.replace('_', ' '))}</span>
        </div>
        <div class="muted">Connection <code>${escapeHtml(c.id)}</code></div>
        <div>Accounts mapped: ${mappedText} &middot; Last sync: ${formatDate(c.lastSyncedAt)}</div>
        ${pairingList}
        ${stale}
        <div>Consent expiry: ${expiry}</div>
        ${reason}
        <div class="row">
          <form method="get" action="/connections/${encodeURIComponent(c.id)}/pairings">
            <button type="submit">Edit pairings</button>
          </form>
          <form method="post" action="/connections/${encodeURIComponent(c.id)}/reauth">
            <button class="primary" type="submit">Reconnect</button>
          </form>
          <form method="get" action="/connections/${encodeURIComponent(c.id)}/delete">
            <button class="danger" type="submit">Delete</button>
          </form>
        </div>
      </div>`;
    })
    .join('');

  const empty = '<p>No bank connections yet. Add one to get started.</p>';

  return layout(
    'TrueLayer to Actual',
    `<h1>TrueLayer to Actual</h1>
     ${banners}
     <div class="row">
       <form method="get" action="/auth/new"><button class="primary" type="submit">Add bank</button></form>
       <form method="post" action="/sync"><button type="submit">Sync now</button></form>
     </div>
     ${data.connections.length ? cards : empty}`
  );
}

export interface BudgetAccounts {
  budget: Budget;
  accounts: ActualAccount[];
}

const NOT_SYNCED = '— not synced —';
const REMOVE = '— remove —';

function accountOption(a: ActualAccount, selectedId?: string): string {
  return (
    `<option value="${escapeHtml(a.id)}"${a.id === selectedId ? ' selected' : ''}>` +
    `${escapeHtml(a.name)}${a.offbudget ? ' (off-budget)' : ''}</option>`
  );
}

function targetLine(
  fieldName: string,
  label: string | undefined,
  ariaLabel: string,
  optionsHtml: string
): string {
  return `<label class="target">${label !== undefined ? `<span>${escapeHtml(label)}</span>` : ''}` +
    `<select name="${escapeHtml(fieldName)}" aria-label="${escapeHtml(ariaLabel)}">${optionsHtml}</select></label>`;
}

function fieldName(truelayerAccountId: string, budgetId: string): string {
  return `map_${truelayerAccountId}__${budgetId}`;
}

/** One select per loaded budget, listing only that budget's accounts. */
function renderLoadedTarget(
  truelayerAccountId: string,
  { budget, accounts }: BudgetAccounts,
  current: string | undefined,
  showLabel: boolean
): string {
  const known = current === undefined || accounts.some((a) => a.id === current);
  const keepUnknown = !known
    ? `<option value="${escapeHtml(current!)}" selected>${escapeHtml(current!)} (unavailable — account not loaded)</option>`
    : '';
  const blank = `<option value=""${current === undefined ? ' selected' : ''}>${current ? REMOVE : NOT_SYNCED}</option>`;
  return targetLine(
    fieldName(truelayerAccountId, budget.id),
    showLabel ? budget.name : undefined,
    budget.name,
    blank + keepUnknown + accounts.map((a) => accountOption(a, current)).join('')
  );
}

/** A mapping whose budget is not loaded (or no longer configured): keep or remove. */
function renderUnavailableTarget(
  truelayerAccountId: string,
  budgetId: string,
  current: string,
  budgetName: string | undefined
): string {
  const label = budgetName ?? `Unknown budget ${budgetId}`;
  const keepText = `${current} (unavailable — budget not loaded)`;
  return targetLine(
    fieldName(truelayerAccountId, budgetId),
    label,
    label,
    `<option value="${escapeHtml(current)}" selected>${escapeHtml(keepText)}</option>` +
      `<option value="">${REMOVE}</option>`
  );
}

export interface PairingPageOptions {
  pairingId: string;
  provider: string;
  items: PairingItem[];
  budgetAccounts: BudgetAccounts[];
  message?: string;
  /** Shown as an error banner, e.g. two budgets sharing one sync id. */
  warning?: string;
}

export function pairingPage(options: PairingPageOptions): string {
  const showLabel = options.budgetAccounts.length > 1;
  const rows = options.items
    .map((item) => {
      const kind = item.accountKind === 'card' ? 'card' : 'account';
      const lines = options.budgetAccounts
        .map((ba) => renderLoadedTarget(item.truelayerAccountId, ba, undefined, showLabel))
        .join('');
      return `<tr>
        <td>${escapeHtml(item.name)}<div class="muted">${escapeHtml(item.currency)} &middot; ${escapeHtml(kind)}</div></td>
        <td><div class="targets">${lines || '<span class="muted">No budgets available</span>'}</div></td>
      </tr>`;
    })
    .join('');

  const noBudgets = options.budgetAccounts.length === 0
    ? '<p class="muted">No budgets configured yet — add one below.</p>'
    : '';

  return layout(
    'Pair accounts',
    `     <h1>Pair ${escapeHtml(options.provider)} accounts</h1>
     ${options.warning ? `<div class="error">${escapeHtml(options.warning)}</div>` : ''}
     ${options.message ? `<div class="banner">${escapeHtml(options.message)}</div>` : ''}
     <p>Choose which Actual account each bank account should sync into in each budget. Leave anything you don't want to import as “not synced”.</p>
     ${noBudgets}
     <form method="post" action="/pair">
       <input type="hidden" name="pairingId" value="${escapeHtml(options.pairingId)}">
       <table>
         <thead><tr><th>TrueLayer</th><th>Actual account</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
       <div class="row"><button class="primary" type="submit">Save pairings</button></div>
     </form>
     <h2>Add a budget</h2>
     <form method="post" action="/budgets">
       <input type="hidden" name="pairingId" value="${escapeHtml(options.pairingId)}">
       <div class="row">
         <input type="text" name="name" placeholder="Budget name" required>
         <input type="text" name="syncId" placeholder="Sync ID" required>
         <input type="password" name="encryptionPassword" placeholder="Encryption password (optional)">
         <button class="primary" type="submit">Add budget</button>
       </div>
     </form>`
  );
}

export interface PairingRow {
  truelayerAccountId: string;
  name: string;
  accountKind: 'account' | 'card';
  currency: string;
  /** Current mappings: budget id -> Actual account id. Empty means unmapped. */
  targets: Record<string, string>;
}

export interface EditPairingsPageOptions {
  connectionId: string;
  provider: string;
  /** Every known TrueLayer account, merged with its current mappings if any. */
  rows: PairingRow[];
  budgetAccounts: BudgetAccounts[];
  /** Every configured budget, loaded or not (to name budgets that failed to load). */
  configuredBudgets?: { id: string; name: string }[];
  message?: string;
  /** Shown as an error banner, e.g. two budgets sharing one sync id. */
  warning?: string;
  /** Non-fatal note, e.g. live TrueLayer accounts could not be fetched. */
  note?: string;
}

/**
 * View and change a connection's account pairings without starting a new
 * TrueLayer authorization. Each bank account gets one select per budget,
 * pre-selected to its current target in that budget.
 */
export function editPairingsPage(options: EditPairingsPageOptions): string {
  const loadedIds = new Set(options.budgetAccounts.map((b) => b.budget.id));
  const configuredName = new Map((options.configuredBudgets ?? []).map((b) => [b.id, b.name]));

  const rows = options.rows
    .map((row) => {
      const kind = row.accountKind === 'card' ? 'card' : 'account';
      const unavailable = Object.entries(row.targets).filter(([budgetId]) => !loadedIds.has(budgetId));
      const showLabel = options.budgetAccounts.length + unavailable.length > 1;

      const lines =
        options.budgetAccounts
          .map((ba) => renderLoadedTarget(row.truelayerAccountId, ba, row.targets[ba.budget.id], showLabel))
          .join('') +
        unavailable
          .map(([budgetId, current]) =>
            renderUnavailableTarget(row.truelayerAccountId, budgetId, current, configuredName.get(budgetId))
          )
          .join('');

      return `<tr>
        <td>${escapeHtml(row.name)}<div class="muted">${escapeHtml(row.currency)} &middot; ${escapeHtml(kind)}</div></td>
        <td><div class="targets">${lines || '<span class="muted">No budgets available</span>'}</div></td>
      </tr>`;
    })
    .join('');

  const empty = options.rows.length === 0 ? '<p>No accounts found for this connection.</p>' : '';
  const noBudgets =
    options.rows.length > 0 && options.budgetAccounts.length === 0
      ? '<p class="muted">No budgets could be loaded, so existing mappings are shown but cannot be changed.</p>'
      : '';

  return layout(
    'Edit pairings',
    `<h1>${escapeHtml(options.provider)} pairings</h1>
     ${options.message ? `<div class="banner">${escapeHtml(options.message)}</div>` : ''}
     ${options.warning ? `<div class="error">${escapeHtml(options.warning)}</div>` : ''}
     ${options.note ? `<div class="banner">${escapeHtml(options.note)}</div>` : ''}
     ${empty}
     ${noBudgets}
     ${
       options.rows.length > 0
         ? `<form method="post" action="/connections/${encodeURIComponent(options.connectionId)}/pairings">
              <p>Choose which Actual account each bank account should sync into in each budget. Leave anything you don't want to import as “not synced”, or choose “remove” to stop syncing it. Changes apply on the next sync.</p>
              <table>
                <thead><tr><th>TrueLayer</th><th>Actual account</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
              <div class="row"><button class="primary" type="submit">Save pairings</button></div>
            </form>`
         : ''
     }
     <p><a href="/">Back to dashboard</a></p>`
  );
}
