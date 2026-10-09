import crypto from 'crypto';
import axios from 'axios';
import {
  generateConnectionId,
  saveConnection,
  getConnection,
  loadConnection,
  removeStaleConnections,
  type Tokens,
} from '../auth/tokens.js';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchTrueLayerAccounts,
  isSandbox,
  requireEnv,
} from '../auth/oauth.js';
import { generateReauthLink, getMe } from '../clients/truelayer.js';
import {
  loadConfigIfExists,
  saveConfig,
  mergeAccounts,
  reconcileConfigAccounts,
  type Config,
  type Account,
} from '../config.js';
import { withStateLock } from '../util/lock.js';
import { logger } from '../logger.js';

const PENDING_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory OAuth state + pairing sessions (15 minute TTL)
// ---------------------------------------------------------------------------

export interface PendingAuth {
  mode: 'new' | 'reauth';
  connectionId?: string;
  previousConnectionId?: string;
  createdAt: number;
}

const pendingAuth = new Map<string, PendingAuth>();

export function createState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function setPending(state: string, entry: Omit<PendingAuth, 'createdAt'>): void {
  pendingAuth.set(state, { ...entry, createdAt: Date.now() });
}

function getPending(state: string): PendingAuth | undefined {
  const entry = pendingAuth.get(state);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingAuth.delete(state);
    return undefined;
  }
  return entry;
}

function consumePending(state: string): PendingAuth | undefined {
  const entry = getPending(state);
  if (entry) pendingAuth.delete(state);
  return entry;
}

export interface PairingItem {
  truelayerAccountId: string;
  name: string;
  accountKind: 'account' | 'card';
  currency: string;
}

export interface PairingSession {
  connectionId: string;
  previousConnectionId?: string;
  mode: 'new' | 'reauth';
  provider: string;
  items: PairingItem[];
  createdAt: number;
}

const pairingSessions = new Map<string, PairingSession>();

function setPairing(session: Omit<PairingSession, 'createdAt'>): string {
  const id = crypto.randomBytes(12).toString('hex');
  pairingSessions.set(id, { ...session, createdAt: Date.now() });
  return id;
}

function consumePairing(id: string): PairingSession | undefined {
  const session = pairingSessions.get(id);
  if (!session) return undefined;
  pairingSessions.delete(id);
  if (Date.now() - session.createdAt > PENDING_TTL_MS) return undefined;
  return session;
}

// ---------------------------------------------------------------------------
// Starting auth flows
// ---------------------------------------------------------------------------

export function startNewAuth(): { state: string; url: string } {
  const clientId = requireEnv('TRUELAYER_CLIENT_ID');
  const redirectUri = requireEnv('TRUELAYER_REDIRECT_URI');
  const sandbox = isSandbox(clientId);
  const state = createState();
  setPending(state, { mode: 'new' });
  return { state, url: buildAuthUrl(clientId, redirectUri, sandbox, state) };
}

export interface ReauthStart {
  url: string;
  usedReauthUri: boolean;
}

/**
 * Start a re-auth for an existing connection. Prefers the ungated
 * `/v1/reauthuri` link; if TrueLayer rejects it (grace window lapsed or the
 * endpoint is unavailable) fall back to a full authorization flow that still
 * preserves existing account mappings by `truelayerAccountId`.
 */
export async function startReauth(connectionId: string): Promise<ReauthStart> {
  const clientId = requireEnv('TRUELAYER_CLIENT_ID');
  const redirectUri = requireEnv('TRUELAYER_REDIRECT_URI');
  const sandbox = isSandbox(clientId);
  const connection = loadConnection(connectionId);

  const state = createState();
  try {
    const url = await generateReauthLink(connection.refreshToken, redirectUri, state);
    setPending(state, { mode: 'reauth', connectionId });
    return { url, usedReauthUri: true };
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status !== 401 && status !== 400 && status !== 404) {
      throw err;
    }
    logger.warn(
      `[${connectionId}] reauthuri rejected${status ? ` (HTTP ${status})` : ''} — ` +
        'falling back to full authorization (mappings will be preserved).'
    );
    const fallbackState = createState();
    setPending(fallbackState, { mode: 'new', previousConnectionId: connectionId });
    return {
      url: buildAuthUrl(clientId, redirectUri, sandbox, fallbackState),
      usedReauthUri: false,
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth callback
// ---------------------------------------------------------------------------

export type CallbackOutcome =
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }
  | { type: 'pair'; pairingId: string; session: PairingSession; warning?: string };

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export async function processCallback(params: CallbackParams): Promise<CallbackOutcome> {
  if (params.error) {
    return { type: 'error', message: params.errorDescription ?? params.error };
  }
  if (!params.code) {
    return { type: 'error', message: 'No authorization code received from TrueLayer.' };
  }
  if (!params.state) {
    return { type: 'error', message: 'Missing state parameter on callback.' };
  }

  const pending = consumePending(params.state);
  if (!pending) {
    return {
      type: 'error',
      message: 'Unknown or expired authorization state. Start the flow again from the dashboard.',
    };
  }

  const clientId = requireEnv('TRUELAYER_CLIENT_ID');
  const clientSecret = requireEnv('TRUELAYER_CLIENT_SECRET');
  const redirectUri = requireEnv('TRUELAYER_REDIRECT_URI');
  const sandbox = isSandbox(clientId);

  const remapFrom =
    pending.previousConnectionId ?? (pending.mode === 'reauth' ? pending.connectionId : undefined);

  // Only retain the previous refresh token for a same-connection reauth, where
  // the old token is still valid. In the grace-lapsed full-auth fallback the old
  // token is dead, so a missing replacement should surface as an error rather
  // than silently storing a token that immediately re-triggers reauth.
  let previousTokens: Tokens | undefined;
  if (pending.mode === 'reauth' && pending.connectionId) {
    try {
      previousTokens = loadConnection(pending.connectionId);
    } catch {
      // Connection vanished — treat as a fresh auth.
    }
  }

  let tokens: Tokens;
  try {
    tokens = await exchangeCodeForTokens({
      clientId,
      clientSecret,
      redirectUri,
      code: params.code,
      sandbox,
      fallbackRefreshToken: previousTokens?.refreshToken,
    });
  } catch (err) {
    return { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  const { accounts, cards } = await fetchTrueLayerAccounts(tokens.accessToken);
  const provider =
    accounts[0]?.provider.display_name ?? cards[0]?.provider.display_name ?? 'Bank';

  // Best-effort connection metadata.
  try {
    const me = await getMe(tokens.accessToken);
    tokens.providerId = me.provider?.provider_id;
    tokens.providerDisplayName = me.provider?.display_name ?? provider;
    tokens.consentExpiresAt = me.consent_expires_at;
    tokens.consentStatus = me.consent_status;
  } catch (err) {
    logger.debug(
      'Could not fetch connection metadata during callback:',
      err instanceof Error ? err.message : String(err)
    );
  }
  tokens.providerDisplayName = tokens.providerDisplayName ?? provider;
  tokens.needsReauth = false;
  tokens.reauthReason = undefined;

  const connectionId =
    pending.mode === 'reauth' && pending.connectionId
      ? pending.connectionId
      : generateConnectionId();

  const items: PairingItem[] = [
    ...accounts.map((a) => ({
      truelayerAccountId: a.account_id,
      name: a.display_name,
      accountKind: 'account' as const,
      currency: a.currency,
    })),
    ...cards.map((c) => ({
      truelayerAccountId: c.account_id,
      name: c.display_name,
      accountKind: 'card' as const,
      currency: c.currency,
    })),
  ];

  const fetchedIds = new Set(items.map((i) => i.truelayerAccountId));

  // All shared-state mutation happens here, under the state lock, re-reading
  // config inside the critical section. Network I/O is already done, so the
  // lock is not held across the slow part.
  //
  // A config.json that exists but fails to load is a hard error: treating it
  // as empty would make `removeStaleConnections` below delete every other
  // bank's tokens. Tokens are saved before the check so a genuine failure
  // still keeps the fresh grant.
  const { unmapped, error: configError } = await withStateLock(async () => {
    const existingTokens = getConnection(connectionId);
    saveConnection(connectionId, existingTokens ? { ...existingTokens, ...tokens } : tokens);

    let config: Config | null = null;
    try {
      config = await loadConfigIfExists();
    } catch (err) {
      logger.error(
        'Config file exists but could not be loaded during OAuth callback — ' +
          'refusing to reconcile or prune connections:',
        err instanceof Error ? err.message : String(err)
      );
      return {
        unmapped: items,
        error:
          'Config file could not be loaded; your bank was connected but existing ' +
          'account mappings were left untouched. Fix data/config.json and re-pair.',
      };
    }
    if (config) {
      const result = reconcileConfigAccounts(config.accounts, {
        newConnectionId: connectionId,
        remapFrom,
        fetchedIds,
      });
      for (const account of result.missing) {
        logger.warn(
          `Previously mapped account "${account.name}" was not returned by TrueLayer. ` +
            'Keeping the mapping.'
        );
      }
      if (result.changed) {
        config.accounts = result.accounts;
        await saveConfig(config);
      }
    }

    const mappedIds = new Set((config?.accounts ?? []).map((a) => a.truelayerAccountId));
    const active = new Set((config?.accounts ?? []).map((a) => a.connectionId));
    active.add(connectionId);
    removeStaleConnections(active);

    return { unmapped: items.filter((i) => !mappedIds.has(i.truelayerAccountId)) };
  });

  if (unmapped.length === 0) {
    return {
      type: 'done',
      message: configError ? `${provider} is connected. ${configError}` : `${provider} is connected.`,
    };
  }

  const sessionBase = {
    connectionId,
    previousConnectionId: remapFrom,
    mode: pending.mode,
    provider,
    items: unmapped,
  };
  const pairingId = setPairing(sessionBase);
  return {
    type: 'pair',
    pairingId,
    session: { ...sessionBase, createdAt: Date.now() },
    warning: configError,
  };
}

// ---------------------------------------------------------------------------
// Pairing submission
// ---------------------------------------------------------------------------

export interface SavePairingsResult {
  saved: number;
}

export async function savePairings(
  pairingId: string,
  mapping: Record<string, string>
): Promise<SavePairingsResult> {
  return withStateLock(async () => {
    // A config.json that exists but fails to load is a hard error: merging
    // into an empty list would overwrite it with only the incoming pairings
    // and then delete every other connection's tokens. Check it before
    // consuming the pairing session, so the user can fix the file and
    // resubmit without redoing the whole OAuth flow.
    let existingConfig: Config | null;
    try {
      existingConfig = await loadConfigIfExists();
    } catch (err) {
      logger.error(
        'Config file exists but could not be loaded — refusing to save pairings:',
        err instanceof Error ? err.message : String(err)
      );
      throw new Error(
        'Config file could not be loaded; pairings were not saved. ' +
          'Fix data/config.json and submit the pairing form again.'
      );
    }

    const session = consumePairing(pairingId);
    if (!session) {
      throw new Error('Pairing session expired. Start again from the dashboard.');
    }

    const incoming: Account[] = [];
    for (const item of session.items) {
      const actualAccountId = mapping[item.truelayerAccountId];
      if (!actualAccountId) continue;
      incoming.push({
        name: item.name,
        connectionId: session.connectionId,
        accountKind: item.accountKind,
        truelayerAccountId: item.truelayerAccountId,
        actualAccountId,
        currency: item.currency,
      });
    }

    const merged = mergeAccounts(existingConfig?.accounts ?? [], incoming);
    await saveConfig({
      accounts: merged,
      createdAt: existingConfig?.createdAt ?? new Date().toISOString(),
    });

    removeStaleConnections(new Set(merged.map((a) => a.connectionId)));

    return { saved: incoming.length };
  });
}
