import { db } from '../db/client';
import type { Invoice, Lease, Property } from '../db/types';

// ─────────────────────────────────────────────────────────────
// Phase 3 — landlord views (spec §7): current-period grid,
// cashflow, expiries, monthly rollup. Read-mostly; the only
// write is idempotent invoice generation for a viewed period.
// ─────────────────────────────────────────────────────────────

// ── Period helpers — the ledger runs on Thai wall-clock time ──

/** Today as 'YYYY-MM-DD' in Asia/Bangkok. */
export function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

/** Current billing period 'YYYY-MM' in Asia/Bangkok. */
export function currentPeriod(): string {
  return bangkokToday().slice(0, 7);
}

/** Shift a 'YYYY-MM' period by N months (negative = back). */
export function shiftPeriod(period: string, delta: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const isPeriod = (s: string): boolean => /^\d{4}-\d{2}$/.test(s);

/** Start of a Bangkok billing period as an ISO instant (for timestamptz filters). */
const periodStartIso = (period: string) => `${period}-01T00:00:00+07:00`;

/** Bucket a timestamptz into its Bangkok 'YYYY-MM' month. */
function bangkokMonth(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date(iso));
}

const round2 = (n: number) => Number(n.toFixed(2));

function unitLabel(lease: Lease, property: Property): string {
  return [property.building, property.unit_no].filter(Boolean).join(' ') || property.name || lease.tenant_name;
}

/** A lease bills for a period when the period month overlaps [start_date, end_date]. */
function leaseCoversPeriod(lease: Lease, period: string): boolean {
  return period >= lease.start_date.slice(0, 7) && period <= lease.end_date.slice(0, 7);
}

type LeaseWithProperty = Lease & { property: Property };

async function activeLeasesWithProperty(landlordId: string): Promise<LeaseWithProperty[]> {
  const { data: props, error: pErr } = await db.from('properties').select('id').eq('landlord_id', landlordId);
  if (pErr) throw new Error(`activeLeases/properties: ${pErr.message}`);
  const ids = (props ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 0) return [];

  const { data, error } = await db
    .from('leases')
    .select('*, property:properties(*)')
    .in('property_id', ids)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`activeLeases: ${error.message}`);
  return (data ?? []) as LeaseWithProperty[];
}

// ── Invoice generation (lazy, idempotent) ──────────────────────

/**
 * Make sure every active lease billing in `period` has its invoice row.
 * Idempotent via unique (lease_id, period_month) + ignoreDuplicates, so a
 * first-invoice override or an already-paid invoice is never clobbered.
 * Phase 5's cron will call this same function on a schedule.
 */
export async function ensureInvoicesForPeriod(landlordId: string, period: string): Promise<void> {
  const leases = await activeLeasesWithProperty(landlordId);
  const rows = leases
    .filter((l) => leaseCoversPeriod(l, period))
    .map((l) => ({
      lease_id: l.id,
      period_month: period,
      amount_due: Number(l.rent_amount),
      due_date: `${period}-${String(l.due_day).padStart(2, '0')}`,
    }));
  if (rows.length === 0) return;

  const { error } = await db
    .from('invoices')
    .upsert(rows, { onConflict: 'lease_id,period_month', ignoreDuplicates: true });
  if (error) throw new Error(`ensureInvoicesForPeriod: ${error.message}`);
}

// ── Per-unit reconciliation grid ───────────────────────────────

export type UnitPayStatus = 'paid' | 'overpaid' | 'partial' | 'missing';

export interface UnitStatusRow {
  leaseId: string;
  propertyId: string;
  unit: string;
  tenant: string;
  due: number;
  paid: number;
  remaining: number;
  status: UnitPayStatus;
  late: boolean;
  dueDate: string | null;
  arrears: number; // still owed from periods BEFORE this one
  income: number; // everything received this period incl. utilities excess
  leaseEnd: string;
}

export interface UnitGrid {
  period: string;
  units: UnitStatusRow[];
  totals: { due: number; paid: number; remaining: number; arrears: number; income: number };
}

/** The current-period grid (spec §7.1): one row per active unit billing in `period`. */
export async function getUnitGrid(landlordId: string, period: string): Promise<UnitGrid> {
  const leases = (await activeLeasesWithProperty(landlordId)).filter((l) => leaseCoversPeriod(l, period));
  const totals = { due: 0, paid: 0, remaining: 0, arrears: 0, income: 0 };
  if (leases.length === 0) return { period, units: [], totals };

  const leaseIds = leases.map((l) => l.id);

  const [{ data: invData, error: invErr }, { data: arrData, error: arrErr }, { data: txnData, error: txnErr }] =
    await Promise.all([
      db.from('invoices').select().in('lease_id', leaseIds).eq('period_month', period),
      db
        .from('invoices')
        .select('lease_id, amount_due, paid_amount')
        .in('lease_id', leaseIds)
        .lt('period_month', period)
        .in('status', ['open', 'partial', 'overdue']),
      db
        .from('transactions')
        .select('property_id, amount')
        .eq('landlord_id', landlordId)
        .eq('direction', 'in')
        .gte('txn_datetime', periodStartIso(period))
        .lt('txn_datetime', periodStartIso(shiftPeriod(period, 1))),
    ]);
  if (invErr) throw new Error(`getUnitGrid/invoices: ${invErr.message}`);
  if (arrErr) throw new Error(`getUnitGrid/arrears: ${arrErr.message}`);
  if (txnErr) throw new Error(`getUnitGrid/transactions: ${txnErr.message}`);

  const invoiceByLease = new Map((invData ?? []).map((i) => [(i as Invoice).lease_id, i as Invoice]));

  const arrearsByLease = new Map<string, number>();
  for (const r of (arrData ?? []) as Array<{ lease_id: string; amount_due: number; paid_amount: number }>) {
    const owed = Math.max(Number(r.amount_due) - Number(r.paid_amount), 0);
    arrearsByLease.set(r.lease_id, (arrearsByLease.get(r.lease_id) ?? 0) + owed);
  }

  const incomeByProperty = new Map<string, number>();
  for (const t of (txnData ?? []) as Array<{ property_id: string | null; amount: number }>) {
    if (!t.property_id) continue;
    incomeByProperty.set(t.property_id, (incomeByProperty.get(t.property_id) ?? 0) + Number(t.amount));
  }

  const today = bangkokToday();
  const units = leases.map((lease): UnitStatusRow => {
    const inv = invoiceByLease.get(lease.id);
    // Fallback for a not-yet-generated invoice: bill the plain rent.
    const due = inv ? Number(inv.amount_due) : Number(lease.rent_amount);
    const paid = inv ? Number(inv.paid_amount) : 0;
    const dueDate = inv ? inv.due_date : `${period}-${String(lease.due_day).padStart(2, '0')}`;

    const status: UnitPayStatus =
      paid <= 0 ? 'missing' : paid < due ? 'partial' : paid > due ? 'overpaid' : 'paid';

    const row: UnitStatusRow = {
      leaseId: lease.id,
      propertyId: lease.property.id,
      unit: unitLabel(lease, lease.property),
      tenant: lease.tenant_name,
      due,
      paid,
      remaining: round2(Math.max(due - paid, 0)),
      status,
      late: paid < due && today > dueDate,
      dueDate,
      arrears: round2(arrearsByLease.get(lease.id) ?? 0),
      income: round2(incomeByProperty.get(lease.property.id) ?? 0),
      leaseEnd: lease.end_date,
    };
    totals.due += due;
    totals.paid += paid;
    totals.remaining += row.remaining;
    totals.arrears += row.arrears;
    totals.income += row.income;
    return row;
  });

  totals.due = round2(totals.due);
  totals.paid = round2(totals.paid);
  totals.remaining = round2(totals.remaining);
  totals.arrears = round2(totals.arrears);
  totals.income = round2(totals.income);
  return { period, units, totals };
}

// ── Portfolio cashflow ─────────────────────────────────────────

export interface CashflowMonth {
  month: string;
  income: number;
  expense: number;
  net: number;
}

/**
 * Monthly in/out/net for the `months` ending at `endPeriod`.
 * `landlordId` scopes to one owner; null = the whole family (incl. pool rows).
 */
export async function getCashflow(
  landlordId: string | null,
  endPeriod: string,
  months = 6,
): Promise<CashflowMonth[]> {
  const startPeriod = shiftPeriod(endPeriod, -(months - 1));
  let query = db
    .from('transactions')
    .select('direction, amount, txn_datetime')
    .gte('txn_datetime', periodStartIso(startPeriod))
    .lt('txn_datetime', periodStartIso(shiftPeriod(endPeriod, 1)));
  if (landlordId !== null) query = query.eq('landlord_id', landlordId);
  const { data, error } = await query;
  if (error) throw new Error(`getCashflow: ${error.message}`);

  const byMonth = new Map<string, CashflowMonth>();
  for (let i = 0; i < months; i++) {
    const month = shiftPeriod(startPeriod, i);
    byMonth.set(month, { month, income: 0, expense: 0, net: 0 });
  }
  for (const t of (data ?? []) as Array<{ direction: 'in' | 'out'; amount: number; txn_datetime: string }>) {
    const bucket = byMonth.get(bangkokMonth(t.txn_datetime));
    if (!bucket) continue;
    if (t.direction === 'in') bucket.income += Number(t.amount);
    else bucket.expense += Number(t.amount);
  }
  for (const b of byMonth.values()) {
    b.income = round2(b.income);
    b.expense = round2(b.expense);
    b.net = round2(b.income - b.expense);
  }
  return [...byMonth.values()];
}

// ── Family overview (pooled + per-condo) ──────────────────────
// The family pools every baht of rent into one common fund, so the
// pooled view is an aggregate over ALL owners' transactions plus
// pool-level rows (landlord_id null — e.g. family spending).

export interface FamilyTxn {
  date: string; // 'YYYY-MM-DD' in Asia/Bangkok
  direction: 'in' | 'out';
  category: string;
  amount: number;
  note: string | null;
}

export interface FamilyPropertyRow {
  propertyId: string;
  name: string;
  owner: string;
  income: number; // this period
  expense: number;
  net: number;
  txns: FamilyTxn[];
}

export interface FamilyOwnerRow {
  name: string;
  income: number;
  expense: number;
  net: number;
}

export interface FamilyOverview {
  period: string;
  totals: { income: number; expense: number; net: number; poolBalance: number };
  owners: FamilyOwnerRow[]; // owners active this period; 'กองกลาง' = pool rows
  properties: FamilyPropertyRow[]; // every condo, active or not
  poolTxns: FamilyTxn[]; // pool-level rows this period
  cashflow: CashflowMonth[];
}

/** Full YYYY-MM-DD Bangkok date of a timestamptz. */
function bangkokDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(iso));
}

const POOL_OWNER = 'กองกลาง';

export async function getFamilyOverview(period: string): Promise<FamilyOverview> {
  interface TxnRow {
    landlord_id: string | null;
    property_id: string | null;
    direction: 'in' | 'out';
    category: string;
    amount: number;
    txn_datetime: string;
    note: string | null;
  }

  const [landlordsRes, propertiesRes, periodTxnsRes, allTxnsRes, cashflow] = await Promise.all([
    db.from('landlords').select('id, display_name'),
    db.from('properties').select('id, name, building, unit_no, landlord_id').order('created_at'),
    db
      .from('transactions')
      .select('landlord_id, property_id, direction, category, amount, txn_datetime, note')
      .gte('txn_datetime', periodStartIso(period))
      .lt('txn_datetime', periodStartIso(shiftPeriod(period, 1)))
      .order('txn_datetime'),
    // Pool balance is lifetime net: every baht in minus every baht out.
    db.from('transactions').select('direction, amount'),
    getCashflow(null, period, 6),
  ]);
  if (landlordsRes.error) throw new Error(`familyOverview/landlords: ${landlordsRes.error.message}`);
  if (propertiesRes.error) throw new Error(`familyOverview/properties: ${propertiesRes.error.message}`);
  if (periodTxnsRes.error) throw new Error(`familyOverview/txns: ${periodTxnsRes.error.message}`);
  if (allTxnsRes.error) throw new Error(`familyOverview/allTxns: ${allTxnsRes.error.message}`);

  const ownerName = new Map<string, string>(
    (landlordsRes.data ?? []).map((l) => [l.id as string, (l.display_name as string | null) ?? '(ไม่มีชื่อ)']),
  );

  let poolBalance = 0;
  for (const t of (allTxnsRes.data ?? []) as Array<{ direction: 'in' | 'out'; amount: number }>) {
    poolBalance += t.direction === 'in' ? Number(t.amount) : -Number(t.amount);
  }

  const toFamilyTxn = (t: TxnRow): FamilyTxn => ({
    date: bangkokDate(t.txn_datetime),
    direction: t.direction,
    category: t.category,
    amount: Number(t.amount),
    note: t.note,
  });

  const totals = { income: 0, expense: 0, net: 0, poolBalance: round2(poolBalance) };
  const ownerAgg = new Map<string, FamilyOwnerRow>();
  const propAgg = new Map<string, { income: number; expense: number; txns: FamilyTxn[] }>();
  const poolTxns: FamilyTxn[] = [];

  for (const t of (periodTxnsRes.data ?? []) as TxnRow[]) {
    const amount = Number(t.amount);
    if (t.direction === 'in') totals.income += amount;
    else totals.expense += amount;

    const owner = t.landlord_id ? (ownerName.get(t.landlord_id) ?? '(ไม่มีชื่อ)') : POOL_OWNER;
    const o = ownerAgg.get(owner) ?? { name: owner, income: 0, expense: 0, net: 0 };
    if (t.direction === 'in') o.income += amount;
    else o.expense += amount;
    ownerAgg.set(owner, o);

    if (t.property_id) {
      const p = propAgg.get(t.property_id) ?? { income: 0, expense: 0, txns: [] };
      if (t.direction === 'in') p.income += amount;
      else p.expense += amount;
      p.txns.push(toFamilyTxn(t));
      propAgg.set(t.property_id, p);
    } else if (!t.landlord_id) {
      poolTxns.push(toFamilyTxn(t));
    }
  }
  totals.income = round2(totals.income);
  totals.expense = round2(totals.expense);
  totals.net = round2(totals.income - totals.expense);

  const owners = [...ownerAgg.values()]
    .map((o) => ({ ...o, income: round2(o.income), expense: round2(o.expense), net: round2(o.income - o.expense) }))
    .sort((a, b) => b.net - a.net);

  const properties = ((propertiesRes.data ?? []) as Array<{
    id: string;
    name: string | null;
    building: string | null;
    unit_no: string | null;
    landlord_id: string;
  }>).map((p): FamilyPropertyRow => {
    const agg = propAgg.get(p.id) ?? { income: 0, expense: 0, txns: [] };
    return {
      propertyId: p.id,
      name: p.name || [p.building, p.unit_no].filter(Boolean).join(' ') || '(ไม่มีชื่อ)',
      owner: ownerName.get(p.landlord_id) ?? '(ไม่มีชื่อ)',
      income: round2(agg.income),
      expense: round2(agg.expense),
      net: round2(agg.income - agg.expense),
      txns: agg.txns,
    };
  });

  return { period, totals, owners, properties, poolTxns, cashflow };
}

// ── Upcoming lease expiries ────────────────────────────────────

export interface ExpiryRow {
  leaseId: string;
  unit: string;
  tenant: string;
  endDate: string;
  daysLeft: number; // negative = already past end_date but still marked active
}

export async function getUpcomingExpiries(landlordId: string, withinDays = 90): Promise<ExpiryRow[]> {
  const leases = await activeLeasesWithProperty(landlordId);
  const today = bangkokToday();
  return leases
    .map((l) => ({
      leaseId: l.id,
      unit: unitLabel(l, l.property),
      tenant: l.tenant_name,
      endDate: l.end_date,
      daysLeft: Math.round((Date.parse(l.end_date) - Date.parse(today)) / 86_400_000),
    }))
    .filter((e) => e.daysLeft <= withinDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

// ── Thai text builders (chat surfaces; Phase 5 cron reuses these) ──

const baht = (n: number) => `฿${Number(n).toLocaleString('en-US')}`;

const STATUS_ICON: Record<UnitPayStatus, string> = {
  paid: '✅',
  overpaid: '🔵',
  partial: '🟡',
  missing: '🔴',
};
const STATUS_TH: Record<UnitPayStatus, string> = {
  paid: 'ชำระครบ',
  overpaid: 'ชำระเกิน',
  partial: 'ชำระบางส่วน',
  missing: 'ยังไม่ชำระ',
};

/** /status body — the owner's current-period view (1:1 chat only). */
export function statusText(grid: UnitGrid): string {
  if (grid.units.length === 0) {
    return `งวด ${grid.period} ยังไม่มีห้องที่เปิดบิล — เพิ่มสัญญาเช่าในแอปก่อนครับ`;
  }
  const lines = [`📊 สถานะงวด ${grid.period}`, ''];
  for (const u of grid.units) {
    lines.push(`${STATUS_ICON[u.status]} ${u.unit} — ${u.tenant}`);
    const detail = [`${STATUS_TH[u.status]} ${baht(u.paid)}/${baht(u.due)}`];
    if (u.remaining > 0) detail.push(`ค้าง ${baht(u.remaining)}`);
    if (u.late) detail.push(`เลยกำหนด (${u.dueDate})`);
    if (u.arrears > 0) detail.push(`ค้างงวดก่อน ${baht(u.arrears)}`);
    lines.push(`　${detail.join(' · ')}`);
  }
  const t = grid.totals;
  lines.push('');
  lines.push(
    t.remaining > 0
      ? `รวม: รับแล้ว ${baht(t.paid)}/${baht(t.due)} · ค้าง ${baht(t.remaining)}`
      : `รวม: รับครบ ${baht(t.paid)} ทุกห้อง 🎉`,
  );
  if (t.arrears > 0) lines.push(`ค้างสะสมจากงวดก่อนหน้า ${baht(t.arrears)}`);
  return lines.join('\n');
}

/** Monthly rollup body — income per unit + who's unpaid (spec §7.3). */
export function monthlySummaryText(grid: UnitGrid): string {
  if (grid.units.length === 0) {
    return `📊 สรุปเดือน ${grid.period}\nไม่มีห้องที่เปิดบิลในเดือนนี้ครับ`;
  }
  const t = grid.totals;
  const lines = [`📊 สรุปเดือน ${grid.period}`, `รายรับรวม ${baht(t.income)}`, ''];
  for (const u of grid.units) {
    lines.push(`${STATUS_ICON[u.status]} ${u.unit}: รับ ${baht(u.income)} (ค่าเช่า ${baht(u.paid)}/${baht(u.due)})`);
  }
  const unpaid = grid.units.filter((u) => u.remaining > 0 || u.arrears > 0);
  if (unpaid.length > 0) {
    lines.push('', '⚠️ ค้างชำระ:');
    for (const u of unpaid) {
      const parts = [];
      if (u.remaining > 0) parts.push(`งวดนี้ ${baht(u.remaining)}`);
      if (u.arrears > 0) parts.push(`งวดก่อน ${baht(u.arrears)}`);
      lines.push(`• ${u.unit} (${u.tenant}) — ${parts.join(' + ')}`);
    }
  } else {
    lines.push('', 'เก็บครบทุกห้อง 🎉');
  }
  return lines.join('\n');
}
