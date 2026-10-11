import { utils } from '@actual-app/api';
import type { TrueLayerTransaction } from './clients/truelayer.js';

export interface ActualTransaction {
  date: string; // 'YYYY-MM-DD'
  amount: number; // integer pence, from utils.amountToInteger()
  payee_name?: string; // merchant_name || description
  notes?: string; // description
  imported_id: string; // see importedIdFor
  cleared: boolean;
}

/**
 * The ID used as Actual's `imported_id`.
 *
 * TrueLayer's `transaction_id` can change when a bank amends a transaction
 * (FX settlement, adjustments, fraud checks), and Actual skips its fuzzy
 * matching when both sides have an imported_id, so a changed ID becomes a
 * duplicate. `normalised_provider_transaction_id` is documented as not subject
 * to change, so prefer it and fall back when the provider doesn't supply it.
 */
export function importedIdFor(t: TrueLayerTransaction): string {
  const stable = t.normalised_provider_transaction_id?.trim();
  return stable ? stable : t.transaction_id;
}

export interface ExistingImport {
  id: string;
  imported_id?: string | null;
}

export interface ImportedIdMigration {
  /** Actual transaction id to update. */
  id: string;
  /** New imported_id (the stable ID). */
  imported_id: string;
}

/**
 * Plan in-place updates so transactions already in Actual under their old
 * `transaction_id` are moved to the stable ID before importing. Without this,
 * switching IDs would re-import every transaction in the lookback window.
 *
 * A row is migrated only when the incoming transaction has a stable ID, no
 * existing row already uses it, and an existing row uses the incoming
 * `transaction_id`. Each existing row is migrated at most once.
 */
export function planImportedIdMigrations(
  txns: TrueLayerTransaction[],
  existing: ExistingImport[]
): ImportedIdMigration[] {
  const rowByImportedId = new Map<string, string>();
  for (const row of existing) {
    if (row.imported_id) rowByImportedId.set(row.imported_id, row.id);
  }

  const migrated = new Set<string>();
  const plan: ImportedIdMigration[] = [];
  for (const t of txns) {
    const stable = importedIdFor(t);
    if (stable === t.transaction_id) continue; // no stable ID, nothing to move
    if (rowByImportedId.has(stable)) continue; // already on the stable ID
    const rowId = rowByImportedId.get(t.transaction_id);
    if (!rowId || migrated.has(rowId)) continue;
    plan.push({ id: rowId, imported_id: stable });
    migrated.add(rowId);
    rowByImportedId.delete(t.transaction_id);
    rowByImportedId.set(stable, rowId);
  }
  return plan;
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
    imported_id: importedIdFor(t),
    cleared,
  };
}
