-- ─────────────────────────────────────────────────────────────
-- 0001_init.sql — core data model (spec §3)
-- ─────────────────────────────────────────────────────────────

create extension if not exists pgcrypto; -- gen_random_uuid()

-- Enums ────────────────────────────────────────────────────────
create type billing_type   as enum ('fixed', 'rent_plus_utilities');
create type lease_status    as enum ('active', 'ended');
create type invoice_status  as enum ('open', 'partial', 'paid', 'overdue');
create type txn_direction   as enum ('in', 'out');
create type txn_source      as enum ('slip', 'manual');
create type verify_status   as enum ('verified', 'unverified', 'duplicate', 'failed');

-- Landlords ────────────────────────────────────────────────────
create table landlords (
  id           uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Properties / units ───────────────────────────────────────────
create table properties (
  id             uuid primary key default gen_random_uuid(),
  landlord_id    uuid not null references landlords(id) on delete cascade,
  name           text,
  building       text,
  unit_no        text,
  purchase_price numeric(14, 2),          -- for net-yield later; nullable
  created_at     timestamptz not null default now()
);
create index properties_landlord_idx on properties(landlord_id);

-- Leases (contracts) ───────────────────────────────────────────
create table leases (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id) on delete cascade,
  tenant_name          text not null,
  tenant_line_user_id  text,
  rent_amount          numeric(12, 2) not null check (rent_amount > 0),
  deposit_amount       numeric(12, 2),
  due_day              int not null check (due_day between 1 and 28),
  billing_type         billing_type not null default 'fixed',
  start_date           date not null,
  end_date             date not null,
  line_group_id        text,                -- group ↔ unit binding
  expected_payer_name  text,                -- strengthens slip matching
  status               lease_status not null default 'active',
  created_at           timestamptz not null default now(),
  constraint leases_end_after_start check (end_date > start_date)
);
create index leases_property_idx on leases(property_id);
create index leases_group_idx    on leases(line_group_id);

-- At most one ACTIVE lease may be bound to a given group at a time
-- (blocks double-binding — spec §4.1 validation guard).
create unique index leases_one_active_per_group
  on leases(line_group_id)
  where status = 'active' and line_group_id is not null;

-- Invoices (one per lease per billing period) ──────────────────
create table invoices (
  id           uuid primary key default gen_random_uuid(),
  lease_id     uuid not null references leases(id) on delete cascade,
  period_month text not null,               -- 'YYYY-MM', e.g. '2026-08'
  amount_due   numeric(12, 2) not null check (amount_due >= 0),
  due_date     date not null,
  paid_amount  numeric(12, 2) not null default 0 check (paid_amount >= 0),
  status       invoice_status not null default 'open',
  created_at   timestamptz not null default now(),
  constraint invoices_period_format check (period_month ~ '^\d{4}-\d{2}$'),
  unique (lease_id, period_month)           -- idempotent invoice generation
);
create index invoices_lease_period_idx on invoices(lease_id, period_month);

-- Transactions (income + expenses) ─────────────────────────────
create table transactions (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null references landlords(id) on delete cascade,
  property_id   uuid references properties(id) on delete set null,
  lease_id      uuid references leases(id) on delete set null,
  invoice_id    uuid references invoices(id) on delete set null,
  direction     txn_direction not null,
  category      text not null,               -- rent | common_fee | agency | maintenance | tax | utilities | other
  amount        numeric(12, 2) not null check (amount > 0),
  txn_datetime  timestamptz not null,
  source        txn_source not null,
  bank_txn_ref  text,                         -- dedupe key from the slip
  sender_name   text,
  verify_status verify_status not null default 'unverified',
  raw_slip_json jsonb,
  created_at    timestamptz not null default now()
);
create index transactions_landlord_idx on transactions(landlord_id);
create index transactions_invoice_idx  on transactions(invoice_id);

-- Duplicate-slip guard: a given bank reference is recorded once per landlord.
create unique index transactions_dedupe_bank_ref
  on transactions(landlord_id, bank_txn_ref)
  where bank_txn_ref is not null;
