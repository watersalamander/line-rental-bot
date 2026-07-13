import { db } from '../db/client';
import { propertyLabel } from './labels';
import type { Invoice, Lease, Property } from '../db/types';
import type { SlipData } from '../slip/types';

export type ReconStatus =
  | 'paid'
  | 'partial'
  | 'overpaid'
  | 'duplicate'
  | 'no_open_invoice';

export interface ReconResult {
  status: ReconStatus;
  amount: number;
  late: boolean;
  suspect: boolean;
  unit: string;
  period?: string; // invoice period_month
  remaining?: number; // still owed after this payment (partial)
  overpaidBy?: number; // amount over the invoice (fixed overpay)
  utilitiesExcess?: number; // logged separately (rent_plus_utilities)
  duplicateRef?: string;
}

/** Loose name match — strips spaces/case so honorific-free comparisons still pass. */
function nameMatches(expected: string | null | undefined, actual: string | null | undefined): boolean {
  if (!expected || !actual) return true; // nothing to compare against → not suspect
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const e = norm(expected);
  const a = norm(actual);
  return e.length > 0 && a.length > 0 && (a.includes(e) || e.includes(a));
}

function unitLabel(lease: Lease, property: Property): string {
  return propertyLabel(property) || lease.tenant_name;
}

async function findOldestOpenInvoice(leaseId: string): Promise<Invoice | null> {
  const { data, error } = await db
    .from('invoices')
    .select()
    .eq('lease_id', leaseId)
    .in('status', ['open', 'partial', 'overdue'])
    .order('period_month', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findOldestOpenInvoice: ${error.message}`);
  return (data as Invoice | null) ?? null;
}

function invoiceStatusFor(paid: number, due: number): Invoice['status'] {
  if (paid >= due) return 'paid';
  if (paid > 0) return 'partial';
  return 'open';
}

interface ReconcileParams {
  landlordId: string;
  lease: Lease;
  property: Property;
  slip: SlipData;
}

/**
 * Reconcile a verified slip against the lease's ledger (spec §5).
 * Writes the transaction(s) and updates the matched invoice. Assumes the slip
 * has already passed vendor verification.
 */
export async function reconcileSlip(params: ReconcileParams): Promise<ReconResult> {
  const { landlordId, lease, property, slip } = params;
  const unit = unitLabel(lease, property);
  const amount = Number(slip.amount);
  const suspect = !nameMatches(lease.expected_payer_name, slip.senderName);

  // 1. Duplicate guard on our own bank_txn_ref (spec §5.3).
  if (slip.transRef) {
    const { data: dup, error } = await db
      .from('transactions')
      .select('id')
      .eq('landlord_id', landlordId)
      .eq('bank_txn_ref', slip.transRef)
      .maybeSingle();
    if (error) throw new Error(`reconcile/dedupe: ${error.message}`);
    if (dup) return { status: 'duplicate', amount, late: false, suspect, unit, duplicateRef: slip.transRef };
  }

  // 2. Match the oldest still-owed invoice (FIFO — handles late catch-up).
  const invoice = await findOldestOpenInvoice(lease.id);

  const txnDatetime = slip.transDatetime || new Date().toISOString();

  // 3. No open invoice → likely a prepayment. Record as unmatched income, flag.
  if (!invoice) {
    await insertTransaction({
      landlordId,
      propertyId: property.id,
      leaseId: lease.id,
      invoiceId: null,
      category: 'rent',
      amount,
      txnDatetime,
      bankTxnRef: slip.transRef || null,
      senderName: slip.senderName,
      raw: slip.raw,
    });
    return { status: 'no_open_invoice', amount, late: false, suspect, unit };
  }

  const due = Number(invoice.amount_due);
  const alreadyPaid = Number(invoice.paid_amount);
  const remainingBefore = due - alreadyPaid;
  const late = isLate(txnDatetime, invoice.due_date);

  // 4. rent_plus_utilities: split rent portion (to invoice) from utilities excess.
  if (lease.billing_type === 'rent_plus_utilities') {
    const rentPortion = Math.min(amount, Math.max(remainingBefore, 0));
    const excess = Number((amount - rentPortion).toFixed(2));
    const newPaid = alreadyPaid + rentPortion;

    await insertTransaction({
      landlordId, propertyId: property.id, leaseId: lease.id, invoiceId: invoice.id,
      category: 'rent', amount: rentPortion > 0 ? rentPortion : amount, txnDatetime,
      bankTxnRef: slip.transRef || null, senderName: slip.senderName, raw: slip.raw,
    });
    if (excess > 0) {
      await insertTransaction({
        landlordId, propertyId: property.id, leaseId: lease.id, invoiceId: null,
        category: 'utilities', amount: excess, txnDatetime,
        bankTxnRef: null, senderName: slip.senderName, raw: slip.raw,
      });
    }
    await updateInvoice(invoice.id, newPaid, invoiceStatusFor(newPaid, due));
    const status: ReconStatus = newPaid >= due ? 'paid' : 'partial';
    return {
      status, amount, late, suspect, unit, period: invoice.period_month,
      remaining: status === 'partial' ? Number((due - newPaid).toFixed(2)) : undefined,
      utilitiesExcess: excess > 0 ? excess : undefined,
    };
  }

  // 5. fixed: straight accumulation.
  const newPaid = alreadyPaid + amount;
  await insertTransaction({
    landlordId, propertyId: property.id, leaseId: lease.id, invoiceId: invoice.id,
    category: 'rent', amount, txnDatetime,
    bankTxnRef: slip.transRef || null, senderName: slip.senderName, raw: slip.raw,
  });
  await updateInvoice(invoice.id, newPaid, invoiceStatusFor(newPaid, due));

  if (newPaid > due) {
    return { status: 'overpaid', amount, late, suspect, unit, period: invoice.period_month, overpaidBy: Number((newPaid - due).toFixed(2)) };
  }
  if (newPaid === due) {
    return { status: 'paid', amount, late, suspect, unit, period: invoice.period_month };
  }
  return { status: 'partial', amount, late, suspect, unit, period: invoice.period_month, remaining: Number((due - newPaid).toFixed(2)) };
}

function isLate(txnIso: string, dueDate: string): boolean {
  const slipDate = txnIso.slice(0, 10); // YYYY-MM-DD (Thai local from vendor)
  return /^\d{4}-\d{2}-\d{2}$/.test(slipDate) && slipDate > dueDate;
}

interface InsertTxnArgs {
  landlordId: string;
  propertyId: string;
  leaseId: string;
  invoiceId: string | null;
  category: string;
  amount: number;
  txnDatetime: string;
  bankTxnRef: string | null;
  senderName: string | null;
  raw: unknown;
}

async function insertTransaction(a: InsertTxnArgs): Promise<void> {
  const { error } = await db.from('transactions').insert({
    landlord_id: a.landlordId,
    property_id: a.propertyId,
    lease_id: a.leaseId,
    invoice_id: a.invoiceId,
    direction: 'in',
    category: a.category,
    amount: a.amount,
    txn_datetime: a.txnDatetime,
    source: 'slip',
    bank_txn_ref: a.bankTxnRef,
    sender_name: a.senderName,
    verify_status: 'verified',
    raw_slip_json: a.raw,
  });
  if (error) throw new Error(`insertTransaction: ${error.message}`);
}

async function updateInvoice(id: string, paidAmount: number, status: Invoice['status']): Promise<void> {
  const { error } = await db
    .from('invoices')
    .update({ paid_amount: Number(paidAmount.toFixed(2)), status })
    .eq('id', id);
  if (error) throw new Error(`updateInvoice: ${error.message}`);
}
