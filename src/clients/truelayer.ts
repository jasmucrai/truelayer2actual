import axios, { AxiosError } from 'axios';
import { logger } from '../logger.js';
import { HTTP_TIMEOUT_MS, describeErrorBody } from '../util/http.js';
import { describeError } from '../util/errors.js';

export interface TrueLayerAccount {
  account_id: string;
  display_name: string;
  currency: string;
  account_type: string;
  provider: { display_name: string };
}

export interface TrueLayerCard {
  account_id: string;
  display_name: string;
  currency: string;
  card_type: string; // 'VISA' | 'MASTERCARD' etc.
  partial_card_number?: string;
  provider: { display_name: string };
}

export interface TrueLayerTransaction {
  transaction_id: string;
  timestamp: string; // ISO 8601
  amount: number; // negative = debit
  currency: string;
  transaction_type: string; // 'debit' | 'credit'
  transaction_classification: string[];
  merchant_name?: string;
  description: string;
  status?: string; // 'booked' | 'pending'
  running_balance?: { amount: number; currency: string };
}

export interface TrueLayerBalance {
  current: number;
  available: number;
  currency: string;
}

export interface TrueLayerMe {
  consent_expires_at?: string;
  consent_status?: string;
  provider?: { provider_id?: string; display_name?: string };
  scopes?: string[];
}

export class ConsentExpiredError extends Error {
  constructor(message = 'TrueLayer consent has expired') {
    super(message);
    this.name = 'ConsentExpiredError';
  }
}

interface TrueLayerResponse<T> {
  results: T[];
  status: string;
}

export function isSandbox(): boolean {
  const clientId = process.env.TRUELAYER_CLIENT_ID ?? '';
  return clientId.startsWith('sandbox-');
}

export function apiBaseUrl(): string {
  return isSandbox()
    ? 'https://api.truelayer-sandbox.com'
    : 'https://api.truelayer.com';
}

export function authBaseUrl(): string {
  return isSandbox()
    ? 'https://auth.truelayer-sandbox.com'
    : 'https://auth.truelayer.com';
}

function baseUrl(): string {
  return apiBaseUrl();
}

function authConfig(accessToken: string): { headers: Record<string, string>; timeout: number } {
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: HTTP_TIMEOUT_MS,
  };
}

function handleAxiosError(err: unknown, context: string): never {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<{ error?: string; error_description?: string }>;
    const status = axiosErr.response?.status;
    const body = axiosErr.response?.data;
    if (status === 401) {
      throw new Error(
        `${context}: Unauthorized (401). The access token may be expired. ` +
          'Open the dashboard and reconnect this bank.'
      );
    }
    if (status === 403) {
      throw new Error(
        `${context}: Forbidden (403). Check that your TrueLayer app has the required scopes.`
      );
    }
    throw new Error(
      `${context}: HTTP ${status ?? 'unknown'} — ${describeErrorBody(body) ?? axiosErr.message}`
    );
  }
  throw new Error(
    `${context}: ${describeError(err)}`
  );
}

export async function fetchAccounts(
  accessToken: string
): Promise<TrueLayerAccount[]> {
  const url = `${baseUrl()}/data/v1/accounts`;
  logger.debug(`Fetching accounts from ${url}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerAccount>>(url, {
      ...authConfig(accessToken),
    });
    logger.debug(`Fetched ${res.data.results.length} account(s)`);
    return res.data.results;
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 501 || err.response?.status === 404)) {
      logger.debug('Accounts endpoint not supported by this provider — skipping');
      return [];
    }
    handleAxiosError(err, 'fetchAccounts');
  }
}

export async function fetchCards(
  accessToken: string
): Promise<TrueLayerCard[]> {
  const url = `${baseUrl()}/data/v1/cards`;
  logger.debug(`Fetching cards from ${url}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerCard>>(url, {
      ...authConfig(accessToken),
    });
    logger.debug(`Fetched ${res.data.results.length} card(s)`);
    return res.data.results;
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 501)) {
      logger.debug('Cards endpoint not supported by this provider — skipping');
      return [];
    }
    handleAxiosError(err, 'fetchCards');
  }
}

export async function fetchTransactions(
  accessToken: string,
  accountId: string,
  from: string,
  to: string
): Promise<TrueLayerTransaction[]> {
  const url = `${baseUrl()}/data/v1/accounts/${accountId}/transactions`;
  logger.debug(`Fetching transactions for account ${accountId} from ${from} to ${to}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerTransaction>>(url, {
      ...authConfig(accessToken),
      params: { from, to },
    });
    logger.debug(
      `Fetched ${res.data.results.length} transaction(s) for account ${accountId}`
    );
    return res.data.results;
  } catch (err) {
    handleAxiosError(
      err,
      `fetchTransactions(accountId=${accountId}, from=${from}, to=${to})`
    );
  }
}

export async function fetchCardTransactions(
  accessToken: string,
  cardId: string,
  from: string,
  to: string
): Promise<TrueLayerTransaction[]> {
  const url = `${baseUrl()}/data/v1/cards/${cardId}/transactions`;
  logger.debug(`Fetching card transactions for ${cardId} from ${from} to ${to}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerTransaction>>(url, {
      ...authConfig(accessToken),
      params: { from, to },
    });
    logger.debug(`Fetched ${res.data.results.length} card transaction(s) for ${cardId}`);
    return res.data.results;
  } catch (err) {
    handleAxiosError(err, `fetchCardTransactions(cardId=${cardId}, from=${from}, to=${to})`);
  }
}

export async function fetchCardBalance(
  accessToken: string,
  cardId: string
): Promise<TrueLayerBalance> {
  const url = `${baseUrl()}/data/v1/cards/${cardId}/balance`;
  logger.debug(`Fetching card balance for ${cardId}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerBalance>>(url, {
      ...authConfig(accessToken),
    });
    const balance = res.data.results[0];
    if (!balance) throw new Error(`No balance data returned for card ${cardId}`);
    return balance;
  } catch (err) {
    handleAxiosError(err, `fetchCardBalance(cardId=${cardId})`);
  }
}

export async function fetchBalance(
  accessToken: string,
  accountId: string
): Promise<TrueLayerBalance> {
  const url = `${baseUrl()}/data/v1/accounts/${accountId}/balance`;
  logger.debug(`Fetching balance for account ${accountId}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerBalance>>(url, {
      ...authConfig(accessToken),
    });
    const balance = res.data.results[0];
    if (!balance) {
      throw new Error(`No balance data returned for account ${accountId}`);
    }
    return balance;
  } catch (err) {
    handleAxiosError(err, `fetchBalance(accountId=${accountId})`);
  }
}

/**
 * Fetch connection metadata for the access token's connection.
 *
 * A 403 means the access token is fine but the underlying consent has lapsed —
 * callers should mark the connection as needing re-auth rather than treating it
 * as a fatal error.
 */
export async function getMe(accessToken: string): Promise<TrueLayerMe> {
  const url = `${baseUrl()}/data/v1/me`;
  logger.debug(`Fetching connection metadata from ${url}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerMe>>(url, {
      ...authConfig(accessToken),
    });
    const me = res.data.results[0];
    if (!me) throw new Error('No metadata returned by /data/v1/me');
    return me;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      throw new ConsentExpiredError(
        `TrueLayer /me returned 403: ${describeErrorBody(err.response.data)}`
      );
    }
    handleAxiosError(err, 'getMe');
  }
}

/**
 * Generate a re-authentication link for an existing connection.
 *
 * Uses the ungated `POST /v1/reauthuri` endpoint (no client_secret, no consent
 * screen review). Reuses the existing connection so account mappings and sync
 * history are preserved. UK-only; throws an axios error on 401 when the refresh
 * token / grace window has lapsed, in which case callers should fall back to a
 * full authorization flow.
 */
export async function generateReauthLink(
  refreshToken: string,
  redirectUri: string,
  state: string
): Promise<string> {
  const url = `${authBaseUrl()}/v1/reauthuri`;
  logger.debug(`Requesting re-auth link from ${url}`);

  const res = await axios.post<{ result: string; success: boolean }>(
    url,
    {
      response_type: 'code',
      refresh_token: refreshToken,
      redirect_uri: redirectUri,
      state,
    },
    { timeout: HTTP_TIMEOUT_MS }
  );

  if (!res.data?.result) {
    throw new Error('TrueLayer returned no re-auth URL');
  }
  return res.data.result;
}
