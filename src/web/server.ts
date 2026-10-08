import http from 'http';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { loadAllConnections, getConnection } from '../auth/tokens.js';
import { loadConfigIfExists, reauthWarnDays, type Config } from '../config.js';
import { withActual, getActualAccounts, getActualError } from '../clients/actual.js';
import { runSync } from '../commands/sync.js';
import { startNewAuth, startReauth, processCallback, savePairings } from './oauth.js';
import {
  dashboardPage,
  pairingPage,
  messagePage,
  type ConnectionStatus,
  type ConnectionView,
} from './pages.js';
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

  let accounts: Config['accounts'] = [];
  try {
    accounts = (await loadConfigIfExists())?.accounts ?? [];
  } catch {
    accounts = [];
  }

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

function bannerFromQuery(req: Request): { message?: string; error?: string } {
  return {
    message: asString(req.query.msg),
    error: asString(req.query.err),
  };
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
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  // When DASHBOARD_URL is configured, the proxy is expected to forward the
  // public host. Requiring BOTH the Host header and the Origin to match it
  // defeats DNS-rebinding (where Origin and Host match each other, but the
  // attacker controls the resolving domain).
  const dashboard = process.env.DASHBOARD_URL;
  if (dashboard) {
    let dashboardHost: string | undefined;
    try {
      dashboardHost = new URL(dashboard).host;
    } catch {
      // ignore malformed DASHBOARD_URL
    }
    if (dashboardHost) return originHost === dashboardHost && req.headers.host === dashboardHost;
  }

  // No DASHBOARD_URL: fall back to matching the request's own Host header.
  return originHost === req.headers.host;
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
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (!req.path.startsWith('/healthz')) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
      );
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'POST' && !originAllowed(req)) {
      logger.warn('Rejected cross-origin POST:', req.headers.origin ?? '(none)', req.path);
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

      const actualAccounts = await withActual(() => getActualAccounts());
      res.send(
        pairingPage({
          pairingId: outcome.pairingId,
          provider: outcome.session.provider,
          items: outcome.session.items,
          actualAccounts,
          message:
            outcome.session.mode === 'reauth'
              ? 'Reconnected. Confirm any new accounts below.'
              : undefined,
          warning: outcome.warning,
        })
      );
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
      const mapping: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
        if (key.startsWith('map_') && typeof value === 'string' && value) {
          mapping[key.slice('map_'.length)] = value;
        }
      }
      const { saved } = await savePairings(pairingId, mapping);
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
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP request failed:', err.message);
    res.status(500).send(messagePage('Something went wrong', err.message, { error: true }));
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
