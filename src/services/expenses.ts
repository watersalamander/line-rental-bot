import { db } from '../db/client';
import type { Property } from '../db/types';

// ─────────────────────────────────────────────────────────────
// Phase 4 — expense capture (spec §6). Expenses are recorded the
// moment they arrive (photo or typed amount in the owner's 1:1
// chat) and then refined via quick-reply postbacks. The
// transaction row itself is the conversation state, so an owner
// who never taps the buttons still has the expense on the books.
// ─────────────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES = ['common_fee', 'maintenance', 'utilities', 'tax', 'agency', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_TH: Record<ExpenseCategory, string> = {
  common_fee: 'ค่าส่วนกลาง',
  maintenance: 'ซ่อมบำรุง',
  utilities: 'ค่าน้ำ/ไฟ',
  tax: 'ภาษี',
  agency: 'ค่านายหน้า',
  other: 'อื่นๆ',
};

/** Best-effort keyword → category for typed expenses like "500 ค่าส่วนกลาง". */
export function inferCategory(note: string): ExpenseCategory | null {
  const s = note.toLowerCase();
  if (!s) return null;
  if (/ส่วนกลาง|common/.test(s)) return 'common_fee';
  if (/ซ่อม|ช่าง|repair|maintenance/.test(s)) return 'maintenance';
  if (/น้ำ|ไฟ|ประปา|ไฟฟ้า|เน็ต|internet|utilit/.test(s)) return 'utilities';
  if (/ภาษี|tax/.test(s)) return 'tax';
  if (/นายหน้า|agent|agency/.test(s)) return 'agency';
  return null;
}

/** Thrown when the slip's bank_txn_ref was already recorded for this landlord (unique index 23505). */
export class DuplicateExpenseError extends Error {
  constructor() {
    super('This slip was already recorded.');
    this.name = 'DuplicateExpenseError';
  }
}

export interface CreateExpenseInput {
  landlordId: string;
  amount: number;
  txnDatetime: string;
  source: 'slip' | 'manual';
  category?: ExpenseCategory | null;
  bankTxnRef?: string | null;
  raw?: unknown;
}

export interface ExpenseRow {
  id: string;
  amount: number;
  category: string;
  property_id: string | null;
  property: Property | null;
}

export async function createExpense(input: CreateExpenseInput): Promise<ExpenseRow> {
  const { data, error } = await db
    .from('transactions')
    .insert({
      landlord_id: input.landlordId,
      property_id: null,
      lease_id: null,
      invoice_id: null,
      direction: 'out',
      category: input.category ?? 'other',
      amount: input.amount,
      txn_datetime: input.txnDatetime,
      source: input.source,
      bank_txn_ref: input.bankTxnRef ?? null,
      sender_name: null,
      verify_status: input.source === 'slip' ? 'verified' : 'unverified',
      raw_slip_json: input.raw ?? null,
    })
    .select('id, amount, category, property_id')
    .single();

  if (error) {
    if (error.code === '23505') throw new DuplicateExpenseError();
    throw new Error(`createExpense: ${error.message}`);
  }
  return { ...(data as Omit<ExpenseRow, 'property'>), property: null };
}

/** Assign the expense to one of the landlord's properties (null = general/portfolio). */
export async function setExpenseProperty(
  txnId: string,
  landlordId: string,
  propertyId: string | null,
): Promise<ExpenseRow> {
  if (propertyId) {
    // Ownership check on the target property before pointing the txn at it.
    const { data: prop, error } = await db
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('landlord_id', landlordId)
      .maybeSingle();
    if (error) throw new Error(`setExpenseProperty/check: ${error.message}`);
    if (!prop) throw new Error('Property not found or not yours.');
  }
  return updateExpense(txnId, landlordId, { property_id: propertyId });
}

export async function setExpenseCategory(
  txnId: string,
  landlordId: string,
  category: ExpenseCategory,
): Promise<ExpenseRow> {
  return updateExpense(txnId, landlordId, { category });
}

async function updateExpense(
  txnId: string,
  landlordId: string,
  patch: Record<string, unknown>,
): Promise<ExpenseRow> {
  const { data, error } = await db
    .from('transactions')
    .update(patch)
    .eq('id', txnId)
    .eq('landlord_id', landlordId)
    .eq('direction', 'out')
    .select('id, amount, category, property_id, property:properties(*)')
    .maybeSingle();
  if (error) throw new Error(`updateExpense: ${error.message}`);
  if (!data) throw new Error('Expense not found.');
  const row = data as unknown as ExpenseRow;
  return { ...row, amount: Number(row.amount) };
}
