import { db } from '../db/client';
import type { BillingType, Invoice, Landlord, Lease, Property } from '../db/types';

/** Thrown when a group is already bound to another active lease (unique index 23505). */
export class GroupAlreadyBoundError extends Error {
  constructor() {
    super('กลุ่มนี้เชื่อมกับห้องอื่นอยู่แล้วครับ');
    this.name = 'GroupAlreadyBoundError';
  }
}

export interface CreateLeaseInput {
  landlordId: string;
  propertyId?: string; // existing property, OR provide building + unitNo for a new one
  building?: string;
  unitNo?: string;
  tenantName: string;
  rentAmount: number;
  billingType: BillingType;
  depositAmount?: number | null;
  dueDay: number;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string; // 'YYYY-MM-DD'
  firstInvoiceOverride?: number | null;
  expectedPayerName?: string | null;
}

export interface CreateLeaseResult {
  property: Property;
  lease: Lease;
  invoice: Invoice;
}

export async function listProperties(landlordId: string): Promise<Property[]> {
  const { data, error } = await db
    .from('properties')
    .select()
    .eq('landlord_id', landlordId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`listProperties: ${error.message}`);
  return (data ?? []) as Property[];
}

/**
 * Create a lease end-to-end: resolve/insert the property, insert the lease, and
 * auto-generate the first invoice from the start month + due day (spec §4.1).
 */
export async function createLease(input: CreateLeaseInput): Promise<CreateLeaseResult> {
  // 1. Resolve the property — an existing one (ownership-checked) or a new insert.
  let property: Property;
  if (input.propertyId) {
    const { data, error } = await db
      .from('properties')
      .select()
      .eq('id', input.propertyId)
      .eq('landlord_id', input.landlordId)
      .maybeSingle();
    if (error) throw new Error(`createLease/property: ${error.message}`);
    if (!data) throw new Error('ไม่พบห้องนี้ หรือไม่ใช่ห้องของคุณครับ');
    property = data as Property;
  } else {
    const building = input.building?.trim();
    const unitNo = input.unitNo?.trim();
    if (!building || !unitNo) throw new Error('การเพิ่มห้องใหม่ต้องระบุชื่ออาคารและเลขห้องครับ');
    const { data, error } = await db
      .from('properties')
      .insert({ landlord_id: input.landlordId, building, unit_no: unitNo, name: `${building} ${unitNo}` })
      .select()
      .single();
    if (error) throw new Error(`createLease/newProperty: ${error.message}`);
    property = data as Property;
  }

  // 2. One tenant at a time: reject if an active lease on this property overlaps
  // the new contract's date range. (Ended leases never block; an active lease
  // whose end_date is before the new start_date doesn't either, so a follow-up
  // tenant can be added before the old contract is marked ended.) Select-then-
  // insert is race-prone in theory, but fine at family scale.
  const { data: overlapping, error: overlapErr } = await db
    .from('leases')
    .select('tenant_name, end_date')
    .eq('property_id', property.id)
    .eq('status', 'active')
    .lte('start_date', input.endDate)
    .gte('end_date', input.startDate)
    .limit(1);
  if (overlapErr) throw new Error(`createLease/overlap: ${overlapErr.message}`);
  if (overlapping && overlapping.length > 0) {
    const existing = overlapping[0] as { tenant_name: string; end_date: string };
    throw new Error(
      `ห้องนี้มีสัญญาเช่าที่ยังไม่สิ้นสุดในช่วงเวลาเดียวกันอยู่แล้ว ` +
        `(ผู้เช่า: ${existing.tenant_name} ถึง ${existing.end_date}) — ` +
        'สัญญาใหม่ต้องเริ่มหลังจากสัญญาเดิมสิ้นสุดครับ',
    );
  }

  // 3. Insert the lease.
  const { data: leaseData, error: leaseErr } = await db
    .from('leases')
    .insert({
      property_id: property.id,
      tenant_name: input.tenantName.trim(),
      rent_amount: input.rentAmount,
      deposit_amount: input.depositAmount ?? null,
      due_day: input.dueDay,
      billing_type: input.billingType,
      start_date: input.startDate,
      end_date: input.endDate,
      expected_payer_name: input.expectedPayerName?.trim() || null,
      status: 'active',
    })
    .select()
    .single();
  if (leaseErr) throw new Error(`createLease/lease: ${leaseErr.message}`);
  const lease = leaseData as Lease;

  // 4. Generate the first invoice: period = start month, due = that month's due_day.
  const periodMonth = input.startDate.slice(0, 7); // 'YYYY-MM'
  const dueDate = `${periodMonth}-${String(input.dueDay).padStart(2, '0')}`;
  const amountDue = input.firstInvoiceOverride ?? input.rentAmount;

  const { data: invoiceData, error: invErr } = await db
    .from('invoices')
    .insert({ lease_id: lease.id, period_month: periodMonth, amount_due: amountDue, due_date: dueDate })
    .select()
    .single();
  if (invErr) throw new Error(`createLease/invoice: ${invErr.message}`);

  return { property, lease, invoice: invoiceData as Invoice };
}

/** Resolve the active lease bound to a group, with its property and landlord (for slip reconciliation). */
export async function findActiveLeaseByGroup(
  groupId: string,
): Promise<{ lease: Lease; property: Property; landlord: Landlord } | null> {
  const { data, error } = await db
    .from('leases')
    .select('*, property:properties(*, landlord:landlords(*))')
    .eq('line_group_id', groupId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw new Error(`findActiveLeaseByGroup: ${error.message}`);
  if (!data) return null;

  const row = data as Lease & { property: Property & { landlord: Landlord } };
  const { landlord, ...property } = row.property;
  return { lease: row, property: property as Property, landlord };
}

/**
 * Every active lease not yet bound to a group — across ALL landlords (for
 * /setup). Family-wide on purpose: only the single admin can run /setup, and
 * they register groups for everyone's properties, so per-owner scoping here
 * would make other members' units unbindable.
 */
export async function listUnboundActiveLeases(): Promise<Array<Lease & { property: Property }>> {
  const { data, error } = await db
    .from('leases')
    .select('*, property:properties(*)')
    .eq('status', 'active')
    .is('line_group_id', null)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`listUnboundActiveLeases: ${error.message}`);
  return (data ?? []) as Array<Lease & { property: Property }>;
}

/**
 * Bind a group to any family member's active lease (admin-gated at the call
 * site). Returns the property's owner too, so the caller can route the
 * post-bind reminder prompt to whoever actually owns the unit.
 */
export async function bindGroupToLease(
  leaseId: string,
  groupId: string,
): Promise<Lease & { property: Property & { landlord: Landlord } }> {
  const { data, error } = await db
    .from('leases')
    .update({ line_group_id: groupId })
    .eq('id', leaseId)
    .eq('status', 'active')
    .select('*, property:properties(*, landlord:landlords(*))')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') throw new GroupAlreadyBoundError();
    throw new Error(`bindGroupToLease: ${error.message}`);
  }
  if (!data) throw new Error('ไม่พบสัญญาเช่าที่ใช้งานอยู่ของห้องนี้ครับ');
  return data as Lease & { property: Property & { landlord: Landlord } };
}

/**
 * Detach a lease from its group (admin-gated at the call site). The lease goes
 * back into the /setup picker. `requireGroupId` guards the in-group /unbind
 * flow against stale confirm buttons — the kick-alert flow (admin 1:1) omits it
 * and only requires that the lease is currently bound to something.
 * Returns null when nothing matched (already unbound, or bound elsewhere).
 */
export async function unbindLease(
  leaseId: string,
  requireGroupId?: string,
): Promise<(Lease & { property: Property }) | null> {
  const query = db.from('leases').update({ line_group_id: null }).eq('id', leaseId);
  const scoped = requireGroupId
    ? query.eq('line_group_id', requireGroupId)
    : query.not('line_group_id', 'is', null);
  const { data, error } = await scoped.select('*, property:properties(*)').maybeSingle();

  if (error) throw new Error(`unbindLease: ${error.message}`);
  return (data as (Lease & { property: Property }) | null) ?? null;
}
