// Hand-written row types mirroring supabase/migrations/0001_init.sql.

export type BillingType = 'fixed' | 'rent_plus_utilities';
export type LeaseStatus = 'active' | 'ended';
export type InvoiceStatus = 'open' | 'partial' | 'paid' | 'overdue';

export interface Landlord {
  id: string;
  line_user_id: string;
  display_name: string | null;
  created_at: string;
}

export interface Property {
  id: string;
  landlord_id: string;
  name: string | null;
  building: string | null;
  unit_no: string | null;
  purchase_price: number | null;
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
