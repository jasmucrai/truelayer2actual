# truelayer2actual

Syncs UK bank transactions from [TrueLayer](https://truelayer.com) into a self-hosted [Actual Budget](https://actualbudget.org) instance.

Runs as a Docker container. The default is an always-on process: an Express dashboard (add banks, pair accounts, reconnect, manual sync) plus a sync scheduler in a single Node process. One-shot mode (triggered by external cron) is also supported.

## How it works

1. **One-time setup** — OAuth flow with TrueLayer, pairing of bank accounts to Actual accounts. Do it from the dashboard in a browser, or via the CLI (`npm run setup` locally / `node dist/commands/setup.js` in Docker). Saves `data/config.json` and `data/tokens.json`.
2. **Sync** — reads config, refreshes the TrueLayer token, fetches new transactions per account, imports them into Actual, logs any balance drift. Runs on the built-in scheduler (every `SYNC_INTERVAL_HOURS`), on demand from the dashboard, or once via `node dist/commands/sync.js`.

```
┌─────────────────────────────────┐
│  setup  (dashboard or CLI)      │
│  - TrueLayer OAuth via browser  │
│  - List bank accounts + cards   │
│  - Pair to Actual accounts      │
│  - Save config.json + tokens    │
└────────────────┬────────────────┘
                 │ data/config.json
                 │ data/tokens.json
     ┌───────────▼──────────────────┐
     │  node dist/commands/serve.js │
     │  1. Load config + tokens     │
     │  2. Refresh TrueLayer token  │
     │  3. For each connection:     │
     │     a. Fetch transactions    │
     │     b. Map to Actual format  │
     │     c. importTransactions()  │
     │     d. Log balance drift     │
     │  4. Save updated config      │
     │  (one dead bank never stops  │
     │   the others or the process) │
     └──────────────────────────────┘
```

## Prerequisites

- A [TrueLayer](https://console.truelayer.com) account with a registered application
- A self-hosted [Actual Budget](https://actualbudget.org) server
- Docker (or Node.js 20+ if running locally)

## Setup

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# TrueLayer — from console.truelayer.com
# Use a sandbox- prefix client ID for testing
TRUELAYER_CLIENT_ID=
TRUELAYER_CLIENT_SECRET=
# Must be registered in the TrueLayer console AND use the address your BROWSER
# can reach (NAS IP / Tailscale name — not localhost, unless browsing locally):
TRUELAYER_REDIRECT_URI=http://192.168.1.73:3000/callback

# Actual Budget
ACTUAL_SERVER_URL=http://your-nas:5006
ACTUAL_PASSWORD=
ACTUAL_SYNC_ID=                     # found in Actual → Settings → Advanced
ACTUAL_ENCRYPTION_PASSWORD=         # optional — only if E2E encryption is enabled

# If Actual uses a self-signed certificate:
# NODE_TLS_REJECT_UNAUTHORIZED=0

# Logging
LOG_LEVEL=info            # debug | info | warn | error

# Sync behaviour
SYNC_DAYS_LOOKBACK=7      # how many days back to fetch on first run
SYNC_INTERVAL_HOURS=6     # scheduler interval; 0 = sync once and exit (external cron)
SETUP_PORT=3000

# Dashboard / notifications (npm run serve)
PORT=3000                 # falls back to SETUP_PORT, then 3000
DASHBOARD_URL=            # public URL of the dashboard (optional): used for
                          # notification click-links and the CSRF origin check.
                          # Set it when accessing through a reverse proxy that
                          # rewrites the Host header.
REAUTH_WARN_DAYS=14       # warn/notify when consent expires within this many days
NTFY_URL=                 # optional: full ntfy topic URL
HA_WEBHOOK_URL=           # optional: Home Assistant webhook URL
```

> **Important:** `@actual-app/api` must match your Actual server version. If you get an `out-of-sync-migrations` error, see the [Local setup](#local-setup) section.

### 2. Docker setup

Pull the pre-built image from GitHub Container Registry:
```yaml
# docker-compose.yml
services:
  truelayer2actual:
    image: ghcr.io/jasmucrai/truelayer2actual:latest
    container_name: truelayer2actual
    ports:
      - "3000:3000"
    volumes:
      - /path/to/data:/app/data
    env_file: .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 60s
      timeout: 5s
      retries: 3
```

See [releases](https://github.com/jasmucrai/truelayer2actual/releases) for available versions.

The container runs the always-on dashboard + sync scheduler (`node dist/commands/serve.js`).
Open the dashboard at `http://localhost:3000` (or your reverse-proxied host): add banks,
pair accounts, trigger a sync, and reconnect banks from a browser — no TTY and no
container restarts. The process runs the Express dashboard and the sync scheduler in a
single Node process, so there is no race on `data/tokens.json`/`config.json`.

When a bank's refresh token dies or its consent is about to expire, the connection is
flagged `needsReauth` (visible at `/healthz` and on the dashboard), other banks keep
syncing, and a notification is sent if `NTFY_URL`/`HA_WEBHOOK_URL` is configured.

### 3. Accessing the dashboard

The dashboard is a plain HTTP server on port 3000 with no authentication — it is meant
to be reached from your **local network** (e.g. `http://<nas-ip>:3000`) or through a
reverse proxy. You do **not** need a domain name: raw LAN IPs and Tailscale/MagicDNS
names work as-is.

Two settings interact with how you access it:

**`TRUELAYER_REDIRECT_URI`** — the URL TrueLayer sends the browser back to after the
consent screen. It must match **where your browser runs, not where the container runs**.
The default (`http://localhost:3000/callback`) only works when the browser is on the
same machine as the container. If you browse the NAS from a laptop, use:

```env
TRUELAYER_REDIRECT_URI=http://192.168.1.73:3000/callback
```

and register that exact URI in the [TrueLayer console](https://console.truelayer.com)
(Your app → Redirect URIs). TrueLayer rejects redirects to unregistered URIs.

**`DASHBOARD_URL`** — optional. Only needed when you access the dashboard through a
reverse proxy that rewrites the `Host` header (e.g. Caddy/nginx with a domain name).
Set it to the public URL. Direct IP, Tailscale, and `localhost` access need it unset.

> **Security:** the dashboard's state-changing routes are unauthenticated at the app
> level. Keep it LAN-only (don't port-forward 3000) and/or put it behind the Synology
> reverse proxy with basic auth, or Tailscale. A CSRF origin check rejects browser
> requests initiated by other sites, but that is defence in depth, not authentication.

### 4. Pair accounts

Pair the first bank from the dashboard ("Add bank") — the redirect URI must already be
configured per the section above. Alternatively, run the CLI setup:

```bash
docker compose run --rm -p 3000:3000 truelayer2actual node dist/commands/setup.js
```

> The CLI setup serves the OAuth callback on port 3000 (TrueLayer's redirect target).
> Stop the always-on container first (`docker compose stop truelayer2actual`) or the
> port mapping will conflict.

This opens a browser for TrueLayer OAuth, then prompts you to map each bank account/card to an Actual account. Supports multiple banks — you'll be asked after each one if you want to add another.

### 5. Sync

The built-in scheduler syncs every `SYNC_INTERVAL_HOURS` (default 6). To sync manually,
press **Sync now** on the dashboard, or run:

```bash
docker compose exec truelayer2actual node dist/commands/sync.js
```

On first run it fetches the last `SYNC_DAYS_LOOKBACK` days. Subsequent runs use the last sync timestamp as the start date.

> **Note:** `npm run sync` / `npm run setup` / `npm run serve` only work in a source
> checkout. The Docker image installs production dependencies only — the TypeScript
> runner (`tsx`) is a dev dependency and is not present, so inside the container always
> use the compiled scripts (`node dist/commands/sync.js`, etc.).

### Troubleshooting

- **`invalid_client` during setup** — `TRUELAYER_CLIENT_ID`/`SECRET` don't match the
  TrueLayer app, or `TRUELAYER_REDIRECT_URI` isn't registered on the app *exactly*
  (scheme, host, port, path). The log line printed with the failure shows the exact
  client id and redirect URI that were used.
- **`invalid-schema` / `out-of-sync-migrations` at sync** — `@actual-app/api` and your
  Actual server version have diverged. Open Actual in the browser, let it finish
  migrating, then retry. If it persists, pin `@actual-app/api` to the same version as
  your Actual server and rebuild.
- **Sync/sync-now does nothing visible** — set `LOG_LEVEL=debug` for per-request
  detail, including why the CSRF origin check allowed or rejected a request.

## Docker

### One-off sync (external cron, no dashboard)

If you prefer external scheduling, run a one-shot sync container instead of the
always-on default:

```bash
docker run --rm \
  -v /path/to/data:/app/data \
  --env-file .env \
  truelayer2actual node dist/commands/sync.js
```

### CLI setup (disaster recovery)

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  --env-file .env \
  truelayer2actual node dist/commands/setup.js
```

Stop any always-on container using the same data volume first — besides the port
conflict, concurrent setup and sync runs would race on `data/tokens.json`.

## Scheduling

`SYNC_INTERVAL_HOURS` in `.env` controls the built-in scheduler (used by the always-on
container; default 6 when unset). For external scheduling instead, set it to `0` and
run the one-shot sync from cron:

### Option A: External cron (`SYNC_INTERVAL_HOURS=0`)

The container starts, syncs once, and exits. Scheduling is handled externally — ideal for Synology Task Scheduler or any cron. Replace the compose service with the one-shot shape (`restart: "no"`, command `node dist/commands/sync.js`).

**Synology Task Scheduler:**

1. **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**
2. Run as: `root` (or a docker-capable user)
3. Schedule: daily at 06:00 (or your preferred time)
4. Script:
   ```bash
   docker compose -f /volume1/docker/truelayer2actual/docker-compose.yml \
     run --rm truelayer2actual
   ```
5. Enable **"Send run details by email"** and **"Send only when script terminates abnormally"**

### Option B: Always-on scheduler (default)

The container runs the dashboard and syncs every `SYNC_INTERVAL_HOURS` on its own —
no external cron needed. This is the `docker-compose.yml` shown in the Docker setup
section above.

## Sandbox / testing

TrueLayer provides a sandbox environment with a mock bank that returns predictable test data — no real bank credentials needed.

1. Create a sandbox app at [console.truelayer.com](https://console.truelayer.com)
2. Set `TRUELAYER_CLIENT_ID=sandbox-<your-id>` in `.env` — the `sandbox-` prefix is detected automatically and switches all API calls to sandbox endpoints
3. Run `docker compose run --rm -p 3000:3000 truelayer2actual node dist/commands/setup.js` and authenticate with **Mock Bank** (or add the sandbox bank from the dashboard)

## Local setup

If you need to customize the image or build locally:

```bash
git clone https://github.com/jasmucrai/truelayer2actual.git
cd truelayer2actual
npm install
npm run build
docker build -t truelayer2actual .
```

Then update your `docker-compose.yml`:

```yaml
services:
  truelayer2actual:
    image: truelayer2actual:latest
    # ... rest of config
```

## npm scripts

Available in a source checkout (not in the Docker image — the image ships only
production dependencies and the compiled `dist/`; use `node dist/commands/<name>.js`
inside the container):

| Script | Description |
|---|---|
| `npm run serve` | Always-on dashboard + sync scheduler (what the container runs) |
| `npm run setup` | One-time OAuth + account pairing (CLI) |
| `npm run sync` | Sync transactions (one-shot or loop) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:serve` | Run compiled serve |
| `npm run start:setup` | Run compiled setup |
| `npm run start:sync` | Run compiled sync |
| `npm test` | Run unit tests |

## Project structure

```
src/
├── commands/
│   ├── serve.ts        # Express dashboard + sync scheduler (always-on)
│   ├── setup.ts        # CLI OAuth flow + interactive account pairing
│   └── sync.ts         # Sync core (runSync) + one-shot/loop entry point
├── web/
│   ├── server.ts       # Routes: dashboard, reauth, callback, pair, sync, healthz
│   ├── oauth.ts        # Pending-state store, callback handling, pairing sessions
│   └── pages.ts        # Server-rendered HTML (no frontend build step)
├── auth/
│   ├── server.ts       # Temporary Express OAuth callback server (CLI setup only)
│   ├── oauth.ts        # Shared auth URL / code exchange / account fetch helpers
│   └── tokens.ts       # Token storage, refresh, metadata, expiry check
├── clients/
│   ├── truelayer.ts    # TrueLayer Data API (accounts, transactions, balance, /me, reauthuri)
│   └── actual.ts       # Actual Budget API wrapper + withActual() mutex
├── mapper.ts           # TrueLayer transaction → Actual transaction
├── notify.ts           # ntfy / Home Assistant notifications with dedupe
├── config.ts           # config.json read/write with zod validation
├── util/fs.ts          # Atomic file writes
└── logger.ts           # Structured logging
data/                   # Gitignored — mount as a volume to persist state
├── tokens.json         # TrueLayer OAuth tokens + connection metadata
├── config.json         # Account mappings + sync state
└── actual-cache/       # @actual-app/api local budget cache
```

## License

MIT