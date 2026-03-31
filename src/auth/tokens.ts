import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { z } from 'zod';
import { logger } from '../logger.js';

const TokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
});

export type Tokens = z.infer<typeof TokenSchema>;

// tokens.json stores a map of connectionId → token set (one per bank)
const TokensFileSchema = z.object({
  connections: z.record(z.string(), TokenSchema),
});

type TokensFile = z.infer<typeof TokensFileSchema>;

const TOKENS_PATH = path.join(process.cwd(), 'data', 'tokens.json');

function isSandbox(): boolean {
  return (process.env.TRUELAYER_CLIENT_ID ?? '').startsWith('sandbox-');
}

function tokenUrl(): string {
  return isSandbox()
    ? 'https://auth.truelayer-sandbox.com/connect/token'
    : 'https://auth.truelayer.com/connect/token';
}

function readTokensFile(): TokensFile {
  if (!fs.existsSync(TOKENS_PATH)) {
    return { connections: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to parse tokens file at ${TOKENS_PATH}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const result = TokensFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid tokens file at ${TOKENS_PATH}: ${result.error.message}. Re-run "npm run setup".`
    );
  }
  return result.data;
}

function writeTokensFile(data: TokensFile): void {
  const dir = path.dirname(TOKENS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function generateConnectionId(): string {
  return `conn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function saveConnection(connectionId: string, tokens: Tokens): void {
  const file = fs.existsSync(TOKENS_PATH) ? readTokensFile() : { connections: {} };
  file.connections[connectionId] = tokens;
  writeTokensFile(file);
  logger.debug(`Saved connection ${connectionId} to tokens.json`);
}

export function loadConnection(connectionId: string): Tokens {
  const file = readTokensFile();
  const tokens = file.connections[connectionId];
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

export async function refreshConnectionIfNeeded(
  connectionId: string,
  tokens: Tokens
): Promise<string> {
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

  let response: { access_token: string; refresh_token: string; expires_in: number };
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
    });
    const res = await axios.post<typeof response>(tokenUrl(), params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    response = res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.response?.data?.error === 'invalid_grant') {
        logger.error(
          `[${connectionId}] Refresh token is invalid or expired. ` +
            'Re-run "npm run setup" to re-authenticate.'
        );
        process.exit(1);
      }
      throw new Error(
        `Failed to refresh token for ${connectionId}: ` +
          `${err.response?.status ?? 'unknown'} — ${JSON.stringify(err.response?.data)}`
      );
    }
    throw err;
  }

  const updated: Tokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
  };
  saveConnection(connectionId, updated);
  logger.info(`[${connectionId}] Token refreshed successfully`);
  return updated.accessToken;
}
