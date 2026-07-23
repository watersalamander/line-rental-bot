// Hand-written row types mirroring supabase/migrations/0001_init.sql.

export type BillingType = 'fixed' | 'rent_plus_utilities';
export type LeaseStatus = 'active' | 'ended';
export type InvoiceStatus = 'open' | 'partial' | 'paid' | 'overdue';

export interface Landlord {
  id: string;
  line_user_id: string | null; // null until the member first messages the bot (0003)
  display_name: string | null;
  created_at: string;
}

export interface Property {
  id: string;
  landlord_id: string;
  name: string | null;
  building: string | null;
  unit_no: string | null;
  floor_level: string | null; // 0005
  size_sqm: number | null; // 0005
  purchase_price: number | null;
  rental_aim: number | null; // 0005 — target rent per month
  created_at: string;
}

export interface Lease {
  id: string;
  property_id: string;
  tenant_name: string;
  tenant_line_user_id: string | null;
  rent_amount: number;
  deposit_amount: number | null;
  due_day: number;
  billing_type: BillingType;
  start_date: string;
  end_date: string;
  line_group_id: string | null;
  expected_payer_name: string | null;
  status: LeaseStatus;
  created_at: string;
}

export interface InviteCode {
  code: string;
  created_by: string; // admin LINE userId (0006)
  created_at: string;
  expires_at: string;
  used_by: string | null; // LINE userId that redeemed it — permanent "was invited" record
  used_at: string | null;
}

export interface Invoice {
  id: string;
  lease_id: string;
  period_month: string; // 'YYYY-MM'
  amount_due: number;
  due_date: string;
  paid_amount: number;
  status: InvoiceStatus;
  created_at: string;
}
