import axios from 'axios';
import {
  authBaseUrl,
  fetchAccounts,
  fetchCards,
  type TrueLayerAccount,
  type TrueLayerCard,
} from '../clients/truelayer.js';
import type { Tokens } from './tokens.js';
import { HTTP_TIMEOUT_MS, describeErrorBody } from '../util/http.js';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'Please copy .env.example to .env and fill in the values.'
    );
  }
  return value;
}

export function isSandbox(clientId = process.env.TRUELAYER_CLIENT_ID ?? ''): boolean {
  return clientId.startsWith('sandbox-');
}

export function tokenUrl(sandbox: boolean): string {
  return sandbox
    ? 'https://auth.truelayer-sandbox.com/connect/token'
    : 'https://auth.truelayer.com/connect/token';
}

/**
 * Build the TrueLayer authorization URL used for first-time consent and for
 * full re-auth when the reauth grace window has lapsed.
 */
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  sandbox: boolean,
  state?: string
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'accounts balance transactions cards offline_access',
    redirect_uri: redirectUri,
    providers: 'uk-cs-mock uk-ob-all uk-oauth-all',
    prompt: 'consent',
  });
  if (state) params.set('state', state);
  return `${authBaseUrl()}/?${params.toString()}`;
}

export interface ExchangeOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  sandbox: boolean;
  /** Retain the previous refresh token if TrueLayer omits a new one. */
  fallbackRefreshToken?: string;
}

export async function exchangeCodeForTokens(options: ExchangeOptions): Promise<Tokens> {
  const { clientId, clientSecret, redirectUri, code, sandbox, fallbackRefreshToken } = options;

  let data: { access_token: string; refresh_token?: string; expires_in: number };
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    const res = await axios.post<typeof data>(tokenUrl(sandbox), params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: HTTP_TIMEOUT_MS,
    });
    data = res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      throw new Error(
        `Token exchange failed: ${err.response?.status ?? 'unknown'} — ${describeErrorBody(err.response?.data)}`
      );
    }
    throw err;
  }

  const refreshToken = data.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error('TrueLayer did not return a refresh token and no previous one is available.');
  }

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    lastAuthAt: new Date().toISOString(),
  };
}

export interface TrueLayerAccountsResult {
  accounts: TrueLayerAccount[];
  cards: TrueLayerCard[];
}

export async function fetchTrueLayerAccounts(
  accessToken: string
): Promise<TrueLayerAccountsResult> {
  const [accounts, cards] = await Promise.all([
    fetchAccounts(accessToken),
    fetchCards(accessToken),
  ]);
  return { accounts, cards };
}
