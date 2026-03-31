import axios, { AxiosError } from 'axios';
import { logger } from '../logger.js';

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

interface TrueLayerResponse<T> {
  results: T[];
  status: string;
}

function isSandbox(): boolean {
  const clientId = process.env.TRUELAYER_CLIENT_ID ?? '';
  return clientId.startsWith('sandbox-');
}

function baseUrl(): string {
  return isSandbox()
    ? 'https://api.truelayer-sandbox.com'
    : 'https://api.truelayer.com';
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function handleAxiosError(err: unknown, context: string): never {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<{ error?: string; error_description?: string }>;
    const status = axiosErr.response?.status;
    const body = axiosErr.response?.data;
    if (status === 401) {
      throw new Error(
        `${context}: Unauthorized (401). Your access token may be expired. ` +
          'Try running "npm run sync" again or re-authenticate with "npm run setup".'
      );
    }
    if (status === 403) {
      throw new Error(
        `${context}: Forbidden (403). Check that your TrueLayer app has the required scopes.`
      );
    }
    throw new Error(
      `${context}: HTTP ${status ?? 'unknown'} — ${JSON.stringify(body) ?? axiosErr.message}`
    );
  }
  throw new Error(
    `${context}: ${err instanceof Error ? err.message : String(err)}`
  );
}

export async function fetchAccounts(
  accessToken: string
): Promise<TrueLayerAccount[]> {
  const url = `${baseUrl()}/data/v1/accounts`;
  logger.debug(`Fetching accounts from ${url}`);

  try {
    const res = await axios.get<TrueLayerResponse<TrueLayerAccount>>(url, {
      headers: authHeaders(accessToken),
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
      headers: authHeaders(accessToken),
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
      headers: authHeaders(accessToken),
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
      headers: authHeaders(accessToken),
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
      headers: authHeaders(accessToken),
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
      headers: authHeaders(accessToken),
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
