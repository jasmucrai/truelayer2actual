# truelayer2actual

Syncs UK bank transactions from [TrueLayer](https://truelayer.com) into a self-hosted [Actual Budget](https://actualbudget.org) instance.

Designed for a single user running on a Synology NAS via Docker, triggered by an external scheduler — not a persistent process.

## How it works

1. **One-time setup** (`npm run setup`) — OAuth flow with TrueLayer, interactive pairing of bank accounts to Actual accounts, saves `data/config.json` and `data/tokens.json`.
2. **Scheduled sync** (`npm run sync`) — reads config, refreshes the TrueLayer token, fetches new transactions per account, imports them into Actual, logs any balance drift, exits.

```
┌─────────────────────────────────┐
│  npm run setup  (run once)      │
│  - TrueLayer OAuth via browser  │
│  - List bank accounts + cards   │
│  - Interactive CLI pairing      │
│  - Save config.json + tokens    │
└────────────────┬────────────────┘
                 │ data/config.json
                 │ data/tokens.json
     ┌───────────▼──────────────────┐
     │  npm run sync  (on cron)     │
     │  1. Load config + tokens     │
     │  2. Refresh TrueLayer token  │
     │  3. For each account:        │
     │     a. Fetch transactions    │
     │     b. Map to Actual format  │
     │     c. importTransactions()  │
     │     d. Log balance drift     │
     │  4. Save updated config      │
     │  5. api.shutdown()           │
     │  6. exit 0                   │
     └──────────────────────────────┘
```

## Prerequisites

- A [TrueLayer](https://console.truelayer.com) account with a registered application
- A self-hosted [Actual Budget](https://actualbudget.org) server
- Node.js 20+ (or Docker)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jasmucrai/truelayer2actual.git
cd truelayer2actual
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# TrueLayer — from console.truelayer.com
# Use a sandbox- prefix client ID for testing
TRUELAYER_CLIENT_ID=
TRUELAYER_CLIENT_SECRET=
TRUELAYER_REDIRECT_URI=http://localhost:3000/auth/callback

# Actual Budget
ACTUAL_SERVER_URL=http://your-nas:5006
ACTUAL_PASSWORD=
ACTUAL_SYNC_ID=                     # found in Actual → Settings → Advanced
ACTUAL_ENCRYPTION_PASSWORD=         # optional — only if E2E encryption is enabled

# If Actual uses a self-signed certificate:
# NODE_TLS_REJECT_UNAUTHORIZED=0

# Sync behaviour
SYNC_DAYS_LOOKBACK=7
SETUP_PORT=3000
```

> **Important:** `@actual-app/api` must match your Actual server version. If you get an `out-of-sync-migrations` error, run:
> ```bash
> npm install @actual-app/api@<your-server-version>
> ```

### 3. Pair accounts

```bash
npm run setup
```

This opens a browser for TrueLayer OAuth, then prompts you to map each bank account/card to an Actual account. Supports multiple banks — you'll be asked after each one if you want to add another.

### 4. Sync

```bash
npm run sync
```

On first run it fetches the last `SYNC_DAYS_LOOKBACK` days. Subsequent runs use the last sync timestamp as the start date.

## Docker

### Build and run setup

```bash
docker build -t truelayer2actual .
docker run --rm -it \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  --env-file .env \
  truelayer2actual node dist/commands/setup.js
```

### docker-compose.yml

```yaml
services:
  truelayer2actual:
    image: truelayer2actual:latest
    container_name: truelayer2actual
    volumes:
      - /volume1/docker/truelayer2actual/data:/app/data
    env_file: .env
    restart: "no"  # triggered by cron, not always-on
```

Run a sync:

```bash
docker compose run --rm truelayer2actual
```

## Scheduling (Synology Task Scheduler)

1. **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**
2. Run as: `root` (or a docker-capable user)
3. Schedule: daily at 06:00 (or your preferred time)
4. Script:
   ```bash
   docker compose -f /volume1/docker/truelayer2actual/docker-compose.yml \
     run --rm truelayer2actual
   ```
5. Enable **"Send run details by email"** and **"Send only when script terminates abnormally"**

## Sandbox / testing

TrueLayer provides a sandbox environment with a mock bank that returns predictable test data — no real bank credentials needed.

1. Create a sandbox app at [console.truelayer.com](https://console.truelayer.com)
2. Set `TRUELAYER_CLIENT_ID=sandbox-<your-id>` in `.env` — the `sandbox-` prefix is detected automatically and switches all API calls to sandbox endpoints
3. Run `npm run setup` and authenticate with **Mock Bank**

## npm scripts

| Script | Description |
|---|---|
| `npm run setup` | One-time OAuth + account pairing |
| `npm run sync` | Sync transactions (one-shot) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:setup` | Run compiled setup |
| `npm run start:sync` | Run compiled sync |
| `npm test` | Run unit tests |

## Project structure

```
src/
├── commands/
│   ├── setup.ts        # OAuth flow + interactive account pairing
│   └── sync.ts         # Main sync entry point
├── auth/
│   ├── server.ts       # Temporary Express OAuth callback server
│   └── tokens.ts       # Token storage, refresh, expiry check
├── clients/
│   ├── truelayer.ts    # TrueLayer Data API (accounts, transactions, balance)
│   └── actual.ts       # Actual Budget API wrapper
├── mapper.ts           # TrueLayer transaction → Actual transaction
├── config.ts           # config.json read/write with zod validation
└── logger.ts           # Structured logging
data/                   # Gitignored — volume-mount this on your NAS
├── tokens.json         # TrueLayer OAuth tokens
├── config.json         # Account mappings + sync state
└── actual-cache/       # @actual-app/api local budget cache
```

## License

MIT
