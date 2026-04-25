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
