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

// Manual income (direction 'in') — rent paid in cash / transferred without a
// slip, deposits received. Categories must stay inside the transactions
// category check constraint (migration 0004).
export const INCOME_CATEGORIES = ['rent', 'deposit', 'other'] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export type TxnCategory = ExpenseCategory | IncomeCategory;

export const CATEGORY_TH: Record<TxnCategory, string> = {
  common_fee: 'ค่าส่วนกลาง',
  maintenance: 'ซ่อมบำรุง',
  utilities: 'ค่าน้ำ/ไฟ',
  tax: 'ภาษี',
  agency: 'ค่านายหน้า',
  rent: 'ค่าเช่า',
  deposit: 'เงินมัดจำ',
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
    super('สลิปนี้เคยบันทึกไปแล้วครับ');
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
  direction: 'in' | 'out';
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
    .select('id, amount, category, direction, property_id')
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
    if (!prop) throw new Error('ไม่พบห้องนี้ หรือไม่ใช่ห้องของคุณครับ');
  }
  return updateExpense(txnId, landlordId, { property_id: propertyId });
}

export async function setExpenseCategory(
  txnId: string,
  landlordId: string,
  category: TxnCategory,
): Promise<ExpenseRow> {
  return updateExpense(txnId, landlordId, { category });
}

/**
 * Flip a freshly captured transaction between expense and income (the
 * direction quick-reply step). Flipping resets the category to 'other' so a
 * stale expense default never labels an income row.
 */
export async function setTransactionDirection(
  txnId: string,
  landlordId: string,
  direction: 'in' | 'out',
): Promise<ExpenseRow> {
  return updateExpense(txnId, landlordId, { direction, category: 'other' });
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
    .select('id, amount, category, direction, property_id, property:properties(*)')
    .maybeSingle();
  if (error) throw new Error(`updateExpense: ${error.message}`);
  if (!data) throw new Error('ไม่พบรายการที่บันทึกไว้ครับ');
  const row = data as unknown as ExpenseRow;
  return { ...row, amount: Number(row.amount) };
}
