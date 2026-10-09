import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { z } from 'zod';
import { logger } from '../logger.js';
import { atomicWriteFile } from '../util/fs.js';
import { withStateLock } from '../util/lock.js';
import { HTTP_TIMEOUT_MS, describeErrorBody } from '../util/http.js';
import { isSandbox, tokenUrl } from './oauth.js';

const TokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  // Optional metadata (back-compat with upstream tokens.json)
  providerId: z.string().optional(),
  providerDisplayName: z.string().optional(),
  consentExpiresAt: z.string().optional(),
  consentStatus: z.string().optional(),
  lastAuthAt: z.string().optional(),
  needsReauth: z.boolean().optional(),
  reauthReason: z.string().optional(),
  lastNotifiedAt: z.string().optional(),
  lastNotifiedReason: z.string().optional(),
});

export type Tokens = z.infer<typeof TokenSchema>;

/**
 * Thrown when a connection cannot be used without a fresh user consent
 * (e.g. the refresh token is invalid/expired, or consent has lapsed).
 *
 * Callers should skip the affected connection and surface a re-auth prompt
 * rather than aborting the whole run.
 */
export class ReauthRequiredError extends Error {
  readonly connectionId: string;

  constructor(connectionId: string, message = 'Reauthentication required') {
    super(message);
    this.name = 'ReauthRequiredError';
    this.connectionId = connectionId;
  }
}

// tokens.json stores a map of connectionId → token set (one per bank)
const TokensFileSchema = z.object({
  connections: z.record(z.string(), TokenSchema),
});

type TokensFile = z.infer<typeof TokensFileSchema>;

// Resolved lazily so tests can point the path at a temp directory before the
// first call (main code resolves on first use too).
let tokensPath: string | null = null;

/** Override where tokens.json is read/written (used by tests). */
export function setTokensPathForTests(p: string): void {
  tokensPath = p;
}

function tokensPathResolve(): string {
  return (tokensPath ??= path.join(process.cwd(), 'data', 'tokens.json'));
}

function readTokensFile(): TokensFile {
  if (!fs.existsSync(tokensPathResolve())) {
    return { connections: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(tokensPathResolve(), 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to parse tokens file at ${tokensPathResolve()}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const result = TokensFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid tokens file at ${tokensPathResolve()}: ${result.error.message}. Re-run "npm run setup".`
    );
  }
  return result.data;
}

function writeTokensFile(data: TokensFile): void {
  atomicWriteFile(tokensPathResolve(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function generateConnectionId(): string {
  return `conn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function saveConnection(connectionId: string, tokens: Tokens): void {
  const file = fs.existsSync(tokensPathResolve()) ? readTokensFile() : { connections: {} };
  file.connections[connectionId] = tokens;
  writeTokensFile(file);
  logger.debug(`Saved connection ${connectionId} to tokens.json`);
}

export function getConnection(connectionId: string): Tokens | undefined {
  return readTokensFile().connections[connectionId];
}

export function loadConnection(connectionId: string): Tokens {
  const tokens = getConnection(connectionId);
  if (!tokens) {
    throw new Error(
      `Connection "${connectionId}" not found in tokens.json. Re-run "npm run setup".`
    );
  }
  return tokens;
}

export function loadAllConnections(): Record<string, Tokens> {
  return readTokensFile().connections;
}

/**
 * Merge a partial patch into an existing connection and persist it atomically,
 * re-reading the current file inside the state lock so concurrent writers
 * (e.g. an OAuth callback) are never clobbered.
 */
function applyConnectionPatch(connectionId: string, patch: Partial<Tokens>): Tokens {
  const current = loadConnection(connectionId);
  const updated: Tokens = { ...current, ...patch };
  saveConnection(connectionId, updated);
  return updated;
}

export function updateConnection(connectionId: string, patch: Partial<Tokens>): Promise<Tokens> {
  return withStateLock(() => applyConnectionPatch(connectionId, patch));
}

/** Persist fresh connection metadata after a successful authenticated call. */
export function markConnectionHealthy(
  connectionId: string,
  meta: {
    providerId?: string;
    providerDisplayName?: string;
    consentExpiresAt?: string;
    consentStatus?: string;
  }
): Promise<Tokens> {
  const patch: Partial<Tokens> = {
    needsReauth: false,
    reauthReason: undefined,
  };
  if (meta.providerId !== undefined) patch.providerId = meta.providerId;
  if (meta.providerDisplayName !== undefined) patch.providerDisplayName = meta.providerDisplayName;
  if (meta.consentExpiresAt !== undefined) patch.consentExpiresAt = meta.consentExpiresAt;
  if (meta.consentStatus !== undefined) patch.consentStatus = meta.consentStatus;
  return updateConnection(connectionId, patch);
}

/** Flag a connection as needing a fresh user consent. */
export function markConnectionNeedsReauth(connectionId: string, reason: string): Promise<Tokens> {
  return updateConnection(connectionId, { needsReauth: true, reauthReason: reason });
}

export function removeStaleConnections(activeConnectionIds: Set<string>): void {
  const file = readTokensFile();
  let changed = false;
  for (const id of Object.keys(file.connections)) {
    if (!activeConnectionIds.has(id)) {
      delete file.connections[id];
      changed = true;
      logger.debug(`Removed stale connection ${id} from tokens.json`);
    }
  }
  if (changed) writeTokensFile(file);
}

export interface RefreshDeps {
  post?: typeof axios.post;
  /**
   * Persist only the fields owned by a refresh. Defaults to a locked
   * read-merge-write so metadata written by a concurrent OAuth callback
   * (`lastAuthAt`, consent, notifications) is preserved.
   */
  persist?: (connectionId: string, patch: Partial<Tokens>) => void | Promise<void>;
}

export async function refreshConnectionIfNeeded(
  connectionId: string,
  tokens: Tokens,
  deps: RefreshDeps = {}
): Promise<string> {
  const post = deps.post ?? axios.post;
  const persist = deps.persist ?? ((id, patch) => updateConnection(id, patch));

  const expiresAt = new Date(tokens.expiresAt).getTime();
  const BUFFER_MS = 60 * 1000;

  if (Date.now() < expiresAt - BUFFER_MS) {
    logger.debug(`[${connectionId}] Access token still valid, skipping refresh`);
    return tokens.accessToken;
  }

  logger.info(`[${connectionId}] Access token expiring soon, refreshing...`);

  const clientId = process.env.TRUELAYER_CLIENT_ID;
  const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('TRUELAYER_CLIENT_ID and TRUELAYER_CLIENT_SECRET must be set to refresh tokens.');
  }

  let response: { access_token: string; refresh_token?: string; expires_in: number };
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
    });
    const res = await post<typeof response>(tokenUrl(isSandbox()), params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: HTTP_TIMEOUT_MS,
    });
    response = res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const error = err.response?.data?.error;
      // `invalid_grant` means the refresh token is dead and a fresh consent is
      // required. Other 4xx codes (e.g. `invalid_request`) are most likely
      // malformed-request bugs or transient provider quirks — treat them as
      // retryable errors rather than permanently flagging the connection.
      // 5xx / network errors are likewise retryable and must NOT flip the
      // connection into reauth-needed.
      if (status && status >= 400 && status < 500 && error === 'invalid_grant') {
        logger.error(
          `[${connectionId}] Refresh token is invalid or expired. ` +
            'Re-authenticate from the dashboard to reconnect this bank.'
        );
        await persist(connectionId, {
          needsReauth: true,
          reauthReason: 'refresh_token_invalid',
        });
        throw new ReauthRequiredError(connectionId, 'Refresh token is invalid or expired');
      }
      // Everything else (network failure, 5xx, throttling) is retryable.
      throw new Error(
        `Failed to refresh token for ${connectionId}: ` +
          `${status ?? 'unknown'} — ${describeErrorBody(err.response?.data)}`
      );
    }
    throw err;
  }

  const accessToken = response.access_token;
  await persist(connectionId, {
    accessToken,
    // TrueLayer may omit refresh_token on refresh — keep the existing one.
    refreshToken: response.refresh_token ?? tokens.refreshToken,
    expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
    needsReauth: false,
    reauthReason: undefined,
  });
  logger.info(`[${connectionId}] Token refreshed successfully`);
  return accessToken;
}
