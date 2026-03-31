import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as api from '@actual-app/api';
import { logger } from '../logger.js';

const CACHE_DIR = path.join(process.cwd(), 'data', 'actual-cache');

export interface ActualAccount {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
}

export interface ActualTransaction {
  date: string;
  amount: number;
  payee_name?: string;
  notes?: string;
  imported_id: string;
  cleared: boolean;
}

export interface ImportResult {
  added: string[];
  updated: string[];
  errors?: string[];
}

export async function initActual(): Promise<void> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.debug(`Created Actual cache directory: ${CACHE_DIR}`);
  }

  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const syncId = process.env.ACTUAL_SYNC_ID;

  if (!serverUrl || !password || !syncId) {
    throw new Error(
      'ACTUAL_SERVER_URL, ACTUAL_PASSWORD, and ACTUAL_SYNC_ID must all be set.'
    );
  }

  logger.info(`Initialising Actual Budget at ${serverUrl}...`);

  try {
    await (api as unknown as { init: (opts: Record<string, unknown>) => Promise<void> }).init({
      dataDir: CACHE_DIR,
      serverURL: serverUrl,
      password,
    });
  } catch (err) {
    logger.error(
      'Actual init error (full):',
      JSON.stringify(err, Object.getOwnPropertyNames(err as object))
    );
    throw new Error(
      `Failed to initialise Actual Budget: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const encryptionPassword = process.env.ACTUAL_ENCRYPTION_PASSWORD;

  try {
    if (encryptionPassword) {
      await (api as unknown as {
        downloadBudget: (id: string, opts: { password: string }) => Promise<void>;
      }).downloadBudget(syncId, { password: encryptionPassword });
    } else {
      await (api as unknown as {
        downloadBudget: (id: string) => Promise<void>;
      }).downloadBudget(syncId);
    }
    logger.info('Actual Budget budget downloaded successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('out-of-sync-migrations') || message.includes('migration')) {
      logger.error(
        'Actual Budget schema is out of sync. ' +
          'Please open Actual Budget in your browser, let it migrate, then retry.'
      );
      process.exit(1);
    }
    throw new Error(`Failed to download Actual Budget budget: ${message}`);
  }
}

export async function shutdownActual(): Promise<void> {
  try {
    await (api as unknown as { shutdown: () => Promise<void> }).shutdown();
    logger.debug('Actual Budget shut down cleanly');
  } catch (err) {
    logger.warn(
      'Error during Actual Budget shutdown:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function getActualAccounts(): Promise<ActualAccount[]> {
  const accounts = await (api as unknown as {
    getAccounts: () => Promise<ActualAccount[]>;
  }).getAccounts();
  return accounts.filter((a) => !a.closed);
}

export async function importToActual(
  accountId: string,
  transactions: ActualTransaction[]
): Promise<ImportResult> {
  if (transactions.length === 0) {
    logger.debug(`No transactions to import for account ${accountId}`);
    return { added: [], updated: [] };
  }

  logger.debug(
    `Importing ${transactions.length} transaction(s) into Actual account ${accountId}`
  );

  const result = await (api as unknown as {
    importTransactions: (
      accountId: string,
      transactions: ActualTransaction[]
    ) => Promise<ImportResult>;
  }).importTransactions(accountId, transactions);

  return result;
}

export async function getActualTransactions(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<ActualTransaction[]> {
  const transactions = await (api as unknown as {
    getTransactions: (
      accountId: string,
      startDate: string,
      endDate: string
    ) => Promise<ActualTransaction[]>;
  }).getTransactions(accountId, startDate, endDate);

  return transactions;
}
