import type { ActualAccount } from '../clients/actual.js';
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
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid #8884; }
  select { font: inherit; padding: 4px; }
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

export type ConnectionStatus = 'healthy' | 'expiring' | 'reauth_needed';

export interface ConnectionView {
  id: string;
  provider: string;
  accountCount: number;
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

function formatDate(iso?: string): string {
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
      const reason = c.reason ? `<div class="muted">Reason: ${escapeHtml(c.reason)}</div>` : '';
      return `<div class="conn">
        <div class="conn-header">
          <h2>${escapeHtml(c.provider)}</h2>
          <span class="badge ${escapeHtml(c.status)}">${escapeHtml(c.status.replace('_', ' '))}</span>
        </div>
        <div class="muted">Connection <code>${escapeHtml(c.id)}</code></div>
        <div>Accounts mapped: ${c.accountCount} &middot; Last sync: ${formatDate(c.lastSyncedAt)}</div>
        <div>Consent expiry: ${expiry}</div>
        ${reason}
        <div class="row">
          <form method="post" action="/connections/${encodeURIComponent(c.id)}/reauth">
            <button class="primary" type="submit">Reconnect</button>
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

export interface PairingPageOptions {
  pairingId: string;
  provider: string;
  items: PairingItem[];
  actualAccounts: ActualAccount[];
  message?: string;
  warning?: string;
}

export function pairingPage(options: PairingPageOptions): string {
  const rows = options.items
    .map((item) => {
      const kind = item.accountKind === 'card' ? 'card' : 'account';
      const selectName = `map_${item.truelayerAccountId}`;
      const opts = options.actualAccounts
        .map(
          (a) =>
            `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${
              a.offbudget ? ' (off-budget)' : ''
            }</option>`
        )
        .join('');
      return `<tr>
        <td>${escapeHtml(item.name)}<div class="muted">${escapeHtml(item.currency)} &middot; ${escapeHtml(kind)}</div></td>
        <td>
          <select name="${escapeHtml(selectName)}">
            <option value="">— skip —</option>
            ${opts}
          </select>
        </td>
      </tr>`;
    })
    .join('');

  return layout(
    'Pair accounts',
    `     <h1>Pair ${escapeHtml(options.provider)} accounts</h1>
     ${options.warning ? `<div class="error">${escapeHtml(options.warning)}</div>` : ''}
     ${options.message ? `<div class="banner">${escapeHtml(options.message)}</div>` : ''}
     <p>Choose the matching Actual Budget account for each bank account. Leave anything you do not want to import set to "skip".</p>
     <form method="post" action="/pair">
       <input type="hidden" name="pairingId" value="${escapeHtml(options.pairingId)}">
       <table>
         <thead><tr><th>TrueLayer</th><th>Actual account</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
       <div class="row"><button class="primary" type="submit">Save pairings</button></div>
     </form>`
  );
}
