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

async function propertyIdsForLandlord(landlordId: string): Promise<string[]> {
  const { data, error } = await db.from('properties').select('id').eq('landlord_id', landlordId);
  if (error) throw new Error(`propertyIdsForLandlord: ${error.message}`);
  return (data ?? []).map((r) => (r as { id: string }).id);
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

/** Active leases owned by the landlord that aren't yet bound to a group (for /setup). */
export async function listUnboundActiveLeases(
  landlordId: string,
): Promise<Array<Lease & { property: Property }>> {
  const propIds = await propertyIdsForLandlord(landlordId);
  if (propIds.length === 0) return [];

  const { data, error } = await db
    .from('leases')
    .select('*, property:properties(*)')
    .in('property_id', propIds)
    .eq('status', 'active')
    .is('line_group_id', null)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`listUnboundActiveLeases: ${error.message}`);
  return (data ?? []) as Array<Lease & { property: Property }>;
}

/** Bind a group to one of the landlord's active leases. */
export async function bindGroupToLease(
  leaseId: string,
  groupId: string,
  landlordId: string,
): Promise<Lease & { property: Property }> {
  const propIds = await propertyIdsForLandlord(landlordId);

  const { data, error } = await db
    .from('leases')
    .update({ line_group_id: groupId })
    .eq('id', leaseId)
    .eq('status', 'active')
    .in('property_id', propIds.length ? propIds : ['00000000-0000-0000-0000-000000000000'])
    .select('*, property:properties(*)')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') throw new GroupAlreadyBoundError();
    throw new Error(`bindGroupToLease: ${error.message}`);
  }
  if (!data) throw new Error('ไม่พบห้องนี้ในสัญญาเช่าที่ใช้งานอยู่ของคุณครับ');
  return data as Lease & { property: Property };
}
