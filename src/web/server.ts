import http from 'http';
import net from 'net';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  loadAllConnections,
  getConnection,
  deleteConnection,
  refreshConnectionIfNeeded,
} from '../auth/tokens.js';
import {
  loadConfigIfExists,
  saveConfig,
  budgetFromEnv,
  applyPairingChanges,
  reauthWarnDays,
  removeAccountsForConnection,
  listBudgets,
  addBudget,
  generateBudgetId,
  type Account,
  type Budget,
  type Config,
  type PairingChange,
  duplicateSyncIdGroups,
  DuplicateSyncIdError,
} from '../config.js';
import { fetchTrueLayerAccounts } from '../auth/oauth.js';
import { withBudget, getActualAccounts, getActualError } from '../clients/actual.js';
import { runSync, withSyncLock } from '../commands/sync.js';
import {
  startNewAuth,
  startReauth,
  processCallback,
  savePairings,
  getPairingSession,
  toPairingItems,
  type PairingItem,
  type PairingSelection,
} from './oauth.js';
import {
  dashboardPage,
  pairingPage,
  editPairingsPage,
  PAIRING_SCRIPT_CSP_SOURCE,
  messagePage,
  confirmDeletePage,
  type BudgetAccounts,
  type ConnectionStatus,
  type ConnectionView,
  type PairingRow,
} from './pages.js';
import { withStateLock } from '../util/lock.js';
import { logger } from '../logger.js';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function buildConnectionViews(): Promise<ConnectionView[]> {
  const connections = loadAllConnections();

  const accounts = (await loadConfigIfExists())?.accounts ?? [];

  return Object.entries(connections).map(([id, tokens]) => {
    const mine = accounts.filter((a) => a.connectionId === id);
    const lastSyncedAt = mine
      .map((a) => a.lastSyncedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop();

    let daysLeft: number | undefined;
    if (tokens.consentExpiresAt) {
      const ms = Date.parse(tokens.consentExpiresAt) - Date.now();
      if (Number.isFinite(ms)) daysLeft = Math.floor(ms / 86_400_000);
    }

    let status: ConnectionStatus = 'healthy';
    if (tokens.needsReauth) status = 'reauth_needed';
    else if (daysLeft !== undefined && daysLeft <= reauthWarnDays()) status = 'expiring';

    return {
      id,
      provider: tokens.providerDisplayName ?? tokens.providerId ?? id,
      accountCount: mine.length,
      lastSyncedAt,
      consentExpiresAt: tokens.consentExpiresAt,
      daysLeft,
      status,
      reason: tokens.reauthReason,
    };
  });
}

/**
 * Explain budgets that point at the same Actual file. They necessarily list the
 * same accounts, which otherwise looks like the wrong budget being loaded.
 */
function duplicateSyncIdWarning(budgets: Awaited<ReturnType<typeof listBudgets>>): string | undefined {
  const groups = duplicateSyncIdGroups(budgets);
  if (groups.length === 0) return undefined;
  const names = groups
    .map((group) => group.map((b) => `"${b.name}"`).join(' and '))
    .join('; ');
  return (
    `Budgets ${names} share the same sync ID, so they are the same Actual budget and show ` +
    'identical accounts. Each Actual budget has its own sync ID (Actual → Settings → Advanced); ' +
    'correct the sync ID in data/config.json.'
  );
}

function bannerFromQuery(req: Request): { message?: string; error?: string } {
  return {
    message: asString(req.query.msg),
    error: asString(req.query.err),
  };
}

// Name suffixes that only resolve on a LAN / tailnet, so an attacker's public
// domain can never produce them. Single-label names (`nas`) are also allowed.
const PRIVATE_NAME_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost', '.ts.net'];

function hostnameOf(value: string): string | undefined {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

/**
 * DNS-rebinding defence: only serve requests whose Host header names this box
 * the way a LAN user would — an IP literal, `localhost`, a single-label or
 * LAN/Tailscale name, the DASHBOARD_URL host, or an entry in ALLOWED_HOSTS
 * (comma-separated). A rebinding page on an attacker's domain sends that
 * domain as Host (and matching Origin), so it is rejected here before the
 * origin check, which it would otherwise pass as "same-origin".
 */
export function hostAllowed(hostHeader: string | undefined): boolean {
  // Browsers always send Host; only non-browser HTTP/1.0 clients omit it.
  if (!hostHeader) return true;
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;

  if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) return true;
  if (hostname === 'localhost' || !hostname.includes('.')) return true;
  if (PRIVATE_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;

  const extra = [process.env.DASHBOARD_URL ?? '', ...(process.env.ALLOWED_HOSTS ?? '').split(',')]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(hostnameOf);
  return extra.includes(hostname);
}

/**
 * Load the Actual accounts for each budget, skipping any budget that fails so a
 * single unreachable budget does not blank the whole pairing page.
 */
async function loadBudgetAccounts(budgets: Budget[]): Promise<BudgetAccounts[]> {
  const budgetAccounts: BudgetAccounts[] = [];
  for (const budget of budgets) {
    try {
      const accounts = await withBudget(budget, () => getActualAccounts());
      budgetAccounts.push({ budget, accounts });
    } catch (err) {
      logger.warn(
        `Could not load accounts for budget "${budget.name}":`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return budgetAccounts;
}

/**
 * Fetch the accounts/cards TrueLayer currently reports for a connection using
 * its saved token. Never throws: when the consent has lapsed, the tokens are
 * missing, or TrueLayer is unreachable, `items` is undefined and `note`
 * explains why. A token refresh is serialised with syncs (refresh tokens may
 * rotate, so two concurrent refreshes could kill the connection).
 */
async function fetchLivePairingItems(
  connectionId: string
): Promise<{ items?: PairingItem[]; note?: string }> {
  const connection = getConnection(connectionId);
  if (!connection) {
    return { note: 'Connection tokens are missing; showing saved pairings only.' };
  }
  if (connection.needsReauth) {
    return {
      note: 'This connection needs reconnecting. Showing saved pairings only; reconnect to add or refresh accounts.',
    };
  }
  try {
    const stillValid = Date.now() < new Date(connection.expiresAt).getTime() - 60_000;
    const accessToken = stillValid
      ? connection.accessToken
      : await withSyncLock(async () => {
          const fresh = getConnection(connectionId);
          if (!fresh) throw new Error('connection was deleted');
          return refreshConnectionIfNeeded(connectionId, fresh);
        });
    const { accounts, cards } = await fetchTrueLayerAccounts(accessToken);
    return { items: toPairingItems({ accounts, cards }) };
  } catch (err) {
    return {
      note: `Could not load accounts from TrueLayer (${
        err instanceof Error ? err.message : String(err)
      }). Showing saved pairings only.`,
    };
  }
}

/**
 * Merge the accounts TrueLayer currently reports for a connection with any
 * saved mappings, so the editor can both change and (un)assign accounts. A
 * missing/expired consent or an unreachable API degrades to saved-only rows
 * with an explanatory note instead of an error page.
 */
async function loadPairingRows(
  connectionId: string,
  savedAccounts: Account[]
): Promise<{ rows: PairingRow[]; note?: string }> {
  const savedByTlId = new Map(savedAccounts.map((a) => [a.truelayerAccountId, a]));
  const live = await fetchLivePairingItems(connectionId);
  const items = live.items ?? [];
  const note = live.note;

  const rows: PairingRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    seen.add(item.truelayerAccountId);
    const saved = savedByTlId.get(item.truelayerAccountId);
    rows.push({
      ...item,
      mapped: Boolean(saved),
      budgetId: saved?.budgetId,
      actualAccountId: saved?.actualAccountId,
    });
  }
  for (const saved of savedAccounts) {
    if (seen.has(saved.truelayerAccountId)) continue;
    rows.push({
      truelayerAccountId: saved.truelayerAccountId,
      name: saved.name,
      accountKind: saved.accountKind,
      currency: saved.currency,
      mapped: true,
      budgetId: saved.budgetId,
      actualAccountId: saved.actualAccountId,
    });
  }

  return { rows, note };
}

/**
 * CSRF hardening for the unauthenticated state-changing POST routes: reject
 * requests whose Origin is neither the request host nor DASHBOARD_URL. Requests
 * without an Origin (curl, older clients) are allowed; `Sec-Fetch-Site` is used
 * as an additional signal where the browser provides it. This is defence in
 * depth on top of the proxy's LAN/basic-auth control, not a substitute for it.
 */
function originAllowed(req: Request): boolean {
  // Modern browsers always send this on cross-site requests; `cross-site`
  // means the initiating page lives on another registrable domain.
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite === 'cross-site') return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  // `Origin: null` is the opaque origin browsers send for sandboxed iframes,
  // cross-origin redirect chains and some webviews. A form on this dashboard
  // never produces it, and it is exactly what a sandboxed attacker iframe
  // sends, so reject it rather than treating it like an absent header.
  if (origin === 'null') {
    logger.warn('Origin check: opaque Origin "null" — rejecting.');
    return false;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    logger.warn('Origin check: unparseable Origin header:', origin);
    return false;
  }
  // Same-origin (direct access, or a proxy that preserves Host) is always OK.
  if (originHost === req.headers.host) {
    logger.debug(`Origin check: same-origin (${originHost}) — allowed`);
    return true;
  }

  // Proxied deployments where the proxy rewrites Host: the real public host
  // is configured in DASHBOARD_URL and is an additional allowed origin.
  const dashboard = process.env.DASHBOARD_URL;
  if (dashboard) {
    try {
      if (new URL(dashboard).host === originHost) return true;
    } catch {
      // ignore malformed DASHBOARD_URL
    }
  }
  return false;
}

export function createApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  // Basic hardening headers on every response. Pages are fully server-rendered
  // with no scripts or third-party resources, so `default-src 'none'` is safe.
  // Pages reflect query banners, so intermediaries must not cache them.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // `same-origin`, not `no-referrer`: with no-referrer, browsers send
    // `Origin: null` even on same-origin form POSTs, which the origin check
    // must reject. same-origin still sends no referrer to other sites.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    if (!req.path.startsWith('/healthz')) {
      // The pairing page alone ships one inline script (budget -> account
      // filter), allowed by hash; every other page stays script-free.
      const scriptSrc = req.path.startsWith('/pair/') || /^\/connections\/[^/]+\/pairings$/.test(req.path)
        ? `script-src ${PAIRING_SCRIPT_CSP_SOURCE}; ` : '';
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; ${scriptSrc}style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`
      );
    }
    next();
  });

  // Host allow-list runs first (see hostAllowed). /healthz is exempt so
  // container/orchestrator health checks work whatever Host they send; it
  // exposes no identifiers.
  app.use((req, res, next) => {
    if (req.path === '/healthz' || hostAllowed(req.headers.host)) {
      next();
      return;
    }
    logger.warn('Rejected request with unrecognised Host header:', req.headers.host ?? '(none)', req.path);
    res
      .status(403)
      .send(
        messagePage(
          'Forbidden',
          `Host "${req.headers.host ?? ''}" is not allowed. If this is how you reach the ` +
            'dashboard, add it to ALLOWED_HOSTS (or set DASHBOARD_URL).',
          { error: true }
        )
      );
  });

  app.use((req, res, next) => {
    if (req.method === 'POST' && !originAllowed(req)) {
      logger.warn(
        'Rejected cross-origin POST:',
        req.path,
        JSON.stringify({
          origin: req.headers.origin ?? '(none)',
          host: req.headers.host ?? '(none)',
          secFetchSite: req.headers['sec-fetch-site'] ?? '(none)',
          dashboardUrl: process.env.DASHBOARD_URL ?? '(unset)',
        })
      );
      res
        .status(403)
        .send(messagePage('Forbidden', 'Cross-origin request rejected.', { error: true }));
      return;
    }
    next();
  });

  app.get(
    '/',
    asyncHandler(async (req, res) => {
      const connections = await buildConnectionViews();
      res.send(dashboardPage({ connections, ...bannerFromQuery(req) }));
    })
  );

  app.get(
    '/healthz',
    asyncHandler(async (_req, res) => {
      try {
        const connections = loadAllConnections();
        // Minimal shape: health signals only, no provider names or ids —
        // this endpoint is unauthenticated.
        const view = Object.values(connections).map((tokens) => ({
          needsReauth: Boolean(tokens.needsReauth),
          consentExpiresAt: tokens.consentExpiresAt ?? null,
        }));
        const actualError = getActualError();
        const degraded = view.some((c) => c.needsReauth) || Boolean(actualError);
        res.status(200).json({
          status: degraded ? 'degraded' : 'ok',
          connections: view,
          ...(actualError ? { error: actualError } : {}),
        });
      } catch (err) {
        // Never let a corrupt/unreadable tokens.json make the container unhealthy.
        res.status(200).json({
          status: 'degraded',
          connections: [],
        });
      }
    })
  );

  app.get('/auth/new', (_req, res) => {
    const { url } = startNewAuth();
    res.redirect(url);
  });

  app.post(
    '/connections/:id/reauth',
    asyncHandler(async (req, res) => {
      const connectionId = req.params.id;
      if (!getConnection(connectionId)) {
        res.status(404).send(messagePage('Unknown connection', connectionId, { error: true }));
        return;
      }
      const { url } = await startReauth(connectionId);
      res.redirect(url);
    })
  );

  app.get(
    '/connections/:id/delete',
    asyncHandler(async (req, res) => {
      const connectionId = req.params.id;
      const tokens = getConnection(connectionId);
      if (!tokens) {
        res.status(404).send(messagePage('Unknown connection', connectionId, { error: true }));
        return;
      }
      res.send(confirmDeletePage(connectionId, tokens.providerDisplayName ?? tokens.providerId ?? connectionId));
    })
  );

  app.post(
    '/connections/:id/delete',
    asyncHandler(async (req, res) => {
      const connectionId = req.params.id;
      if (!getConnection(connectionId)) {
        res.status(404).send(messagePage('Unknown connection', connectionId, { error: true }));
        return;
      }
      await deleteConnection(connectionId);
      await removeAccountsForConnection(connectionId);
      res.redirect('/?msg=' + encodeURIComponent('Connection deleted.'));
    })
  );

  app.get(
    '/callback',
    asyncHandler(async (req, res) => {
      const outcome = await processCallback({
        code: asString(req.query.code),
        state: asString(req.query.state),
        error: asString(req.query.error),
        errorDescription: asString(req.query.error_description),
      });

      if (outcome.type === 'error') {
        res.status(400).send(messagePage('Authentication failed', outcome.message, { error: true }));
        return;
      }

      if (outcome.type === 'done') {
        res.redirect('/?msg=' + encodeURIComponent(outcome.message));
        return;
      }

      res.redirect('/pair/' + encodeURIComponent(outcome.pairingId));
    })
  );

  app.get(
    '/pair/:pairingId',
    asyncHandler(async (req, res) => {
      const pairingId = req.params.pairingId;
      const session = getPairingSession(pairingId);
      if (!session) {
        res
          .status(404)
          .send(messagePage('Session expired', 'Pairing session expired. Start again from the dashboard.', { error: true }));
        return;
      }

      const budgets = await listBudgets();
      const budgetAccounts: BudgetAccounts[] = [];
      for (const budget of budgets) {
        try {
          const accounts = await withBudget(budget, () => getActualAccounts());
          budgetAccounts.push({ budget, accounts });
        } catch (err) {
          logger.warn(
            `Could not load accounts for budget "${budget.name}":`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      res.send(
        pairingPage({
          pairingId,
          provider: session.provider,
          items: session.items,
          budgetAccounts,
          warning:
            [session.warning, duplicateSyncIdWarning(budgets), asString(req.query.err)]
              .filter((w): w is string => Boolean(w))
              .join(' ') || undefined,
          message:
            session.mode === 'reauth'
              ? 'Reconnected. Confirm any new accounts below.'
              : undefined,
        })
      );
    })
  );

  app.get(
    '/connections/:id/pairings',
    asyncHandler(async (req, res) => {
      const connectionId = req.params.id;
      const connection = getConnection(connectionId);
      if (!connection) {
        res.status(404).send(messagePage('Unknown connection', connectionId, { error: true }));
        return;
      }

      let accounts: Account[] = [];
      try {
        accounts = ((await loadConfigIfExists())?.accounts ?? []).filter(
          (a) => a.connectionId === connectionId
        );
      } catch (err) {
        logger.warn('Could not read config.json for pairings:', err instanceof Error ? err.message : String(err));
      }

      const budgets = await listBudgets();
      const [budgetAccounts, pairing] = await Promise.all([
        loadBudgetAccounts(budgets),
        loadPairingRows(connectionId, accounts),
      ]);

      res.send(
        editPairingsPage({
          connectionId,
          provider: connection.providerDisplayName ?? connection.providerId ?? connectionId,
          rows: pairing.rows,
          budgetAccounts,
          note: pairing.note,
          message: asString(req.query.msg),
          warning:
            [duplicateSyncIdWarning(budgets), asString(req.query.err)]
              .filter((w): w is string => Boolean(w))
              .join(' ') || undefined,
        })
      );
    })
  );

  app.post(
    '/connections/:id/pairings',
    asyncHandler(async (req, res) => {
      const connectionId = req.params.id;
      if (!getConnection(connectionId)) {
        res.status(404).send(messagePage('Unknown connection', connectionId, { error: true }));
        return;
      }

      // Parse the submitted rows once. Only `map_<tlId>` keys count; everything
      // else (names, currencies) is advisory and never trusted for new rows.
      const body: Record<string, unknown> = req.body ?? {};
      const submitted = new Map<string, { actualAccountId: string; budgetId?: string }>();
      for (const key of Object.keys(body)) {
        if (!key.startsWith('map_')) continue;
        const truelayerAccountId = key.slice('map_'.length);
        submitted.set(truelayerAccountId, {
          actualAccountId: asString(body[key]) ?? '',
          budgetId: asString(body[`budget_${truelayerAccountId}`]),
        });
      }

      // Pairing a previously skipped account needs TrueLayer to vouch for it.
      // Fetch outside the state lock: the token refresh takes that lock itself.
      let liveById: Map<string, PairingItem> | undefined;
      let existingIds = new Set<string>();
      try {
        const current = await loadConfigIfExists();
        existingIds = new Set(
          (current?.accounts ?? [])
            .filter((a) => a.connectionId === connectionId)
            .map((a) => a.truelayerAccountId)
        );
      } catch {
        // A corrupt config is reported by the locked write below.
      }
      const wantsNew = [...submitted].some(
        ([id, row]) => row.actualAccountId && !existingIds.has(id)
      );
      if (wantsNew) {
        const live = await fetchLivePairingItems(connectionId);
        if (live.items) liveById = new Map(live.items.map((i) => [i.truelayerAccountId, i]));
      }

      let changed = 0;
      let removed = 0;
      let ignored = 0;
      try {
        await withStateLock(async () => {
          // Re-read inside the lock so concurrent writers (sync recording
          // lastSyncedAt, other dashboard edits) are not clobbered.
          const loaded = await loadConfigIfExists();
          const envBudget = budgetFromEnv();
          const config: Config = loaded ?? {
            budgets: envBudget ? [envBudget] : [],
            accounts: [],
            createdAt: new Date().toISOString(),
          };
          const budgetIds = new Set(config.budgets.map((b) => b.id));

          const existingByTlId = new Map(
            config.accounts
              .filter((a) => a.connectionId === connectionId)
              .map((a) => [a.truelayerAccountId, a])
          );
          const changes: Record<string, PairingChange> = Object.create(null);
          const added: Account[] = [];

          for (const [truelayerAccountId, row] of submitted) {
            const existing = existingByTlId.get(truelayerAccountId);

            if (!row.actualAccountId) {
              // Blank means "do not sync": drop an existing mapping, ignore a new row.
              if (existing) {
                changes[truelayerAccountId] = { budgetId: existing.budgetId, actualAccountId: '' };
              }
              continue;
            }

            if (!row.budgetId) continue;
            const unchanged =
              existing?.budgetId === row.budgetId &&
              existing.actualAccountId === row.actualAccountId;
            if (!unchanged && !budgetIds.has(row.budgetId)) {
              ignored++;
              continue;
            }

            if (existing) {
              changes[truelayerAccountId] = {
                budgetId: row.budgetId,
                actualAccountId: row.actualAccountId,
              };
              continue;
            }

            const item = liveById?.get(truelayerAccountId);
            if (!item) {
              ignored++;
              continue;
            }
            added.push({
              name: item.name,
              connectionId,
              budgetId: row.budgetId,
              accountKind: item.accountKind,
              truelayerAccountId,
              actualAccountId: row.actualAccountId,
              currency: item.currency,
            });
          }

          const result = applyPairingChanges(config.accounts, connectionId, changes);
          changed = result.changed + added.length;
          removed = result.removed;
          if (changed === 0 && removed === 0) return;

          await saveConfig({
            ...config,
            accounts: [...result.accounts, ...added],
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to update pairings:', message);
        res.redirect('/?err=' + encodeURIComponent(message));
        return;
      }

      const parts = [`Updated ${changed} pairing(s)`];
      if (removed > 0) parts.push(`removed ${removed}`);
      if (ignored > 0) parts.push(`ignored ${ignored} invalid selection(s)`);
      res.redirect(
        '/connections/' +
          encodeURIComponent(connectionId) +
          '/pairings?msg=' +
          encodeURIComponent(parts.join(', ') + '.')
      );
    })
  );

  app.post(
    '/budgets',
    asyncHandler(async (req, res) => {
      const name = asString(req.body?.name);
      const syncId = asString(req.body?.syncId);
      const pairingId = asString(req.body?.pairingId);
      const encryptionPassword = asString(req.body?.encryptionPassword);

      if (!name || !syncId) {
        res
          .status(400)
          .send(messagePage('Invalid request', 'Budget name and sync ID are both required.', { error: true }));
        return;
      }

      try {
        await addBudget({ id: generateBudgetId(), name, syncId, encryptionPassword });
      } catch (err) {
        if (err instanceof DuplicateSyncIdError) {
          if (pairingId) {
            res.redirect(
              '/pair/' + encodeURIComponent(pairingId) + '?err=' + encodeURIComponent(err.message)
            );
          } else {
            res.status(400).send(messagePage('Budget not added', err.message, { error: true }));
          }
          return;
        }
        throw err;
      }

      if (pairingId) {
        res.redirect('/pair/' + encodeURIComponent(pairingId));
      } else {
        res.redirect('/?msg=' + encodeURIComponent(`Added budget "${name}".`));
      }
    })
  );

  app.post(
    '/pair',
    asyncHandler(async (req, res) => {
      const pairingId = asString(req.body?.pairingId);
      if (!pairingId) {
        res.status(400).send(messagePage('Invalid request', 'Missing pairing session.', { error: true }));
        return;
      }

      const session = getPairingSession(pairingId);
      if (!session) {
        res
          .status(400)
          .send(messagePage('Session expired', 'Pairing session expired. Start again from the dashboard.', { error: true }));
        return;
      }

      const selections: Record<string, PairingSelection> = {};
      for (const item of session.items) {
        const budgetId = asString(req.body?.[`budget_${item.truelayerAccountId}`]);
        const actualAccountId = asString(req.body?.[`map_${item.truelayerAccountId}`]);
        if (budgetId && actualAccountId) {
          selections[item.truelayerAccountId] = { budgetId, actualAccountId };
        }
      }

      const { saved } = await savePairings(pairingId, selections);
      res.redirect('/?msg=' + encodeURIComponent(`Saved ${saved} pairing(s).`));
    })
  );

  app.post(
    '/sync',
    asyncHandler(async (_req, res) => {
      try {
        const summary = await runSync();
        const message =
          `Sync finished: ${summary.synced.length} synced, ` +
          `${summary.skipped.length} need re-auth, ${summary.errors.length} error(s).`;
        res.redirect('/?msg=' + encodeURIComponent(message));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Manual sync failed:', message);
        res.redirect('/?err=' + encodeURIComponent(message));
      }
    })
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error(`HTTP ${req.method} ${req.path} failed:`, err.message);
    res.status(500).send(
      messagePage(
        'Something went wrong',
        'An unexpected error occurred. Check the server logs for details.',
        { error: true }
      )
    );
  });

  return app;
}

export async function startServer(port: number): Promise<http.Server> {
  const app = createApp();
  return await new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info(`Dashboard listening on http://localhost:${port}`);
      resolve(server);
    });
    server.on('error', (err) => {
      reject(
        new Error(
          `Failed to start dashboard on port ${port}: ${err.message}. ` +
            'Try setting PORT (or SETUP_PORT) in your environment.'
        )
      );
    });
  });
}
