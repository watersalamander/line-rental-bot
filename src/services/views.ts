import { db } from '../db/client';
import { propertyLabel } from './labels';
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
  return propertyLabel(property) || lease.tenant_name;
}

/** A lease bills for a period when the period month overlaps [start_date, end_date]. */
function leaseCoversPeriod(lease: Pick<Lease, 'start_date' | 'end_date'>, period: string): boolean {
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

// ── Home overview (dashboard main page) ────────────────────────
// One card per condo answering: rented? how much? until when? whose?
// Plus the family pool's lifetime net balance for the hero card.

/** Full YYYY-MM-DD Bangkok date of a timestamptz. */
function bangkokDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(iso));
}

export interface HomeCard {
  propertyId: string;
  name: string;
  owner: string;
  tenant: string | null; // null = no active lease (vacant)
  rent: number | null;
  leaseEnd: string | null; // 'YYYY-MM-DD'
}

export interface HomeOverview {
  poolBalance: number; // lifetime net: every baht in minus every baht out
  properties: HomeCard[];
}

export async function getHomeOverview(): Promise<HomeOverview> {
  const [landlordsRes, propertiesRes, leasesRes, txnsRes] = await Promise.all([
    db.from('landlords').select('id, display_name'),
    db.from('properties').select('id, name, building, unit_no, landlord_id').order('created_at'),
    db.from('leases').select('property_id, tenant_name, rent_amount, end_date').eq('status', 'active'),
    db.from('transactions').select('direction, amount'),
  ]);
  if (landlordsRes.error) throw new Error(`homeOverview/landlords: ${landlordsRes.error.message}`);
  if (propertiesRes.error) throw new Error(`homeOverview/properties: ${propertiesRes.error.message}`);
  if (leasesRes.error) throw new Error(`homeOverview/leases: ${leasesRes.error.message}`);
  if (txnsRes.error) throw new Error(`homeOverview/txns: ${txnsRes.error.message}`);

  const ownerName = new Map<string, string>(
    (landlordsRes.data ?? []).map((l) => [l.id as string, (l.display_name as string | null) ?? '(ไม่มีชื่อ)']),
  );

  // A property with several active leases shows the one ending last.
  type ActiveLease = { property_id: string; tenant_name: string; rent_amount: number; end_date: string };
  const leaseByProperty = new Map<string, ActiveLease>();
  for (const l of (leasesRes.data ?? []) as ActiveLease[]) {
    const prev = leaseByProperty.get(l.property_id);
    if (!prev || l.end_date > prev.end_date) leaseByProperty.set(l.property_id, l);
  }

  let poolBalance = 0;
  for (const t of (txnsRes.data ?? []) as Array<{ direction: 'in' | 'out'; amount: number }>) {
    poolBalance += t.direction === 'in' ? Number(t.amount) : -Number(t.amount);
  }

  const properties = ((propertiesRes.data ?? []) as Array<{
    id: string;
    name: string | null;
    building: string | null;
    unit_no: string | null;
    landlord_id: string;
  }>).map((p): HomeCard => {
    const lease = leaseByProperty.get(p.id);
    return {
      propertyId: p.id,
      name: propertyLabel(p) || '(ไม่มีชื่อ)',
      owner: ownerName.get(p.landlord_id) ?? '(ไม่มีชื่อ)',
      tenant: lease?.tenant_name ?? null,
      rent: lease ? Number(lease.rent_amount) : null,
      leaseEnd: lease?.end_date ?? null,
    };
  });

  // Rented condos first; sort() is stable, so created_at order holds within each group.
  properties.sort((a, b) => Number(b.tenant !== null) - Number(a.tenant !== null));

  return { poolBalance: round2(poolBalance), properties };
}

// ── Property detail (dashboard condo page) ─────────────────────

export interface PropertyTxn {
  date: string; // 'YYYY-MM-DD' in Asia/Bangkok
  month: string; // 'YYYY-MM' Bangkok month — the client's filter key
  direction: 'in' | 'out';
  category: string;
  amount: number;
  note: string | null;
}

export interface PropertyMonthNet {
  month: string;
  income: number;
  expense: number;
  net: number;
}

export type RentState = 'vacant' | 'paid' | 'partial' | 'unpaid';

export interface PropertyInfo {
  floor: string | null;
  unitNo: string | null;
  sizeSqm: number | null;
  purchasePrice: number | null;
  rentalAim: number | null; // target rent per month
}

export interface PropertyDetail {
  propertyId: string;
  name: string;
  owner: string;
  info: PropertyInfo;
  allTime: { income: number; expense: number; net: number };
  rent: { state: RentState; tenant: string | null; due: number; paid: number; dueDate: string | null };
  monthly: PropertyMonthNet[]; // last 12 Bangkok months, oldest first
  txns: PropertyTxn[]; // all of this condo's transactions, newest first
  currentPeriod: string;
}

export async function getPropertyDetail(propertyId: string): Promise<PropertyDetail | null> {
  const period = currentPeriod();

  const propRes = await db
    .from('properties')
    .select('id, name, building, unit_no, landlord_id, floor_level, size_sqm, purchase_price, rental_aim')
    .eq('id', propertyId)
    .maybeSingle();
  if (propRes.error) throw new Error(`propertyDetail/property: ${propRes.error.message}`);
  const prop = propRes.data as {
    id: string;
    name: string | null;
    building: string | null;
    unit_no: string | null;
    landlord_id: string;
    floor_level: string | null;
    size_sqm: number | null;
    purchase_price: number | null;
    rental_aim: number | null;
  } | null;
  if (!prop) return null;

  // Make sure this month's invoice exists before reading paid/unpaid off it.
  await ensureInvoicesForPeriod(prop.landlord_id, period);

  const [ownerRes, leasesRes, txnsRes] = await Promise.all([
    db.from('landlords').select('display_name').eq('id', prop.landlord_id).maybeSingle(),
    db
      .from('leases')
      .select('id, tenant_name, rent_amount, due_day, start_date, end_date')
      .eq('property_id', propertyId)
      .eq('status', 'active'),
    db
      .from('transactions')
      .select('direction, category, amount, txn_datetime, note')
      .eq('property_id', propertyId)
      .order('txn_datetime', { ascending: false }),
  ]);
  if (ownerRes.error) throw new Error(`propertyDetail/owner: ${ownerRes.error.message}`);
  if (leasesRes.error) throw new Error(`propertyDetail/leases: ${leasesRes.error.message}`);
  if (txnsRes.error) throw new Error(`propertyDetail/txns: ${txnsRes.error.message}`);

  // This month's rent status off the active lease billing in `period`.
  type LeaseRow = Pick<Lease, 'id' | 'tenant_name' | 'rent_amount' | 'due_day' | 'start_date' | 'end_date'>;
  const lease = ((leasesRes.data ?? []) as LeaseRow[])
    .filter((l) => leaseCoversPeriod(l, period))
    .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];

  let rent: PropertyDetail['rent'] = { state: 'vacant', tenant: null, due: 0, paid: 0, dueDate: null };
  if (lease) {
    const invRes = await db
      .from('invoices')
      .select('amount_due, paid_amount, due_date')
      .eq('lease_id', lease.id)
      .eq('period_month', period)
      .maybeSingle();
    if (invRes.error) throw new Error(`propertyDetail/invoice: ${invRes.error.message}`);
    const inv = invRes.data as { amount_due: number; paid_amount: number; due_date: string } | null;
    const due = inv ? Number(inv.amount_due) : Number(lease.rent_amount);
    const paid = inv ? Number(inv.paid_amount) : 0;
    rent = {
      state: paid <= 0 ? 'unpaid' : paid < due ? 'partial' : 'paid',
      tenant: lease.tenant_name,
      due: round2(due),
      paid: round2(paid),
      dueDate: inv?.due_date ?? `${period}-${String(lease.due_day).padStart(2, '0')}`,
    };
  }

  // One pass over the condo's transactions: all-time totals, the last-12-months
  // net series for the bar chart, and the (already newest-first) list.
  const startMonth = shiftPeriod(period, -11);
  const byMonth = new Map<string, PropertyMonthNet>();
  for (let i = 0; i < 12; i++) {
    const month = shiftPeriod(startMonth, i);
    byMonth.set(month, { month, income: 0, expense: 0, net: 0 });
  }

  const allTime = { income: 0, expense: 0, net: 0 };
  const txns: PropertyTxn[] = [];
  type TxnRow = { direction: 'in' | 'out'; category: string; amount: number; txn_datetime: string; note: string | null };
  for (const t of (txnsRes.data ?? []) as TxnRow[]) {
    const amount = Number(t.amount);
    if (t.direction === 'in') allTime.income += amount;
    else allTime.expense += amount;

    const month = bangkokMonth(t.txn_datetime);
    const bucket = byMonth.get(month);
    if (bucket) {
      if (t.direction === 'in') bucket.income += amount;
      else bucket.expense += amount;
    }
    txns.push({ date: bangkokDate(t.txn_datetime), month, direction: t.direction, category: t.category, amount, note: t.note });
  }
  allTime.income = round2(allTime.income);
  allTime.expense = round2(allTime.expense);
  allTime.net = round2(allTime.income - allTime.expense);
  for (const b of byMonth.values()) {
    b.income = round2(b.income);
    b.expense = round2(b.expense);
    b.net = round2(b.income - b.expense);
  }

  return {
    propertyId: prop.id,
    name: propertyLabel(prop) || '(ไม่มีชื่อ)',
    owner: (ownerRes.data?.display_name as string | null) ?? '(ไม่มีชื่อ)',
    info: {
      floor: prop.floor_level,
      unitNo: prop.unit_no,
      sizeSqm: prop.size_sqm !== null ? Number(prop.size_sqm) : null,
      purchasePrice: prop.purchase_price !== null ? Number(prop.purchase_price) : null,
      rentalAim: prop.rental_aim !== null ? Number(prop.rental_aim) : null,
    },
    allTime,
    rent,
    monthly: [...byMonth.values()],
    txns,
    currentPeriod: period,
  };
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
