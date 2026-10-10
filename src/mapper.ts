import { utils } from '@actual-app/api';
import type { TrueLayerTransaction } from './clients/truelayer.js';

export interface ActualTransaction {
  date: string; // 'YYYY-MM-DD'
  amount: number; // integer pence, from utils.amountToInteger()
  payee_name?: string; // merchant_name || description
  notes?: string; // description
  imported_id: string; // transaction_id
  cleared: boolean;
}

/**
 * Split fetched transactions into booked (importable) and pending.
 *
 * Pending transactions are not imported: when one settles, TrueLayer can return
 * it under a different transaction_id, so importing both would duplicate the
 * payment in Actual. Booked versions are picked up on a later sync, because the
 * lookback window re-fetches recent days. A missing status is treated as booked,
 * matching mapTransaction.
 */
export function splitPending<T extends TrueLayerTransaction>(
  txns: T[]
): { booked: T[]; pending: T[] } {
  const booked: T[] = [];
  const pending: T[] = [];
  for (const t of txns) {
    if (t.status === undefined || t.status === 'booked') booked.push(t);
    else pending.push(t);
  }
  return { booked, pending };
}

export function mapTransaction(t: TrueLayerTransaction, isCard = false): ActualTransaction {
  // Extract date portion from ISO 8601 timestamp
  const date = t.timestamp.split('T')[0];

  // TrueLayer returns card purchases as positive amounts (charges to the card),
  // but Actual expects negative amounts for a credit card account (increasing liability).
  const rawAmount = isCard ? -t.amount : t.amount;
  const amount = utils.amountToInteger(rawAmount);

  // Prefer merchant_name, fall back to description
  const payee_name = t.merchant_name ?? t.description;

  // Determine cleared status: use status field if present, otherwise default to true
  let cleared: boolean;
  if ('status' in t && t.status !== undefined) {
    cleared = t.status === 'booked';
  } else {
    cleared = true;
  }

  return {
    date,
    amount,
    payee_name,
    notes: t.description,
    imported_id: t.transaction_id,
    cleared,
  };
}
