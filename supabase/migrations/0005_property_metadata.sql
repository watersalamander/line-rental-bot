-- Property metadata from the family CSV (file 2): floor, size, rental target.
-- Shown on the dashboard's per-condo detail page.
alter table properties
  add column if not exists floor_level text,
  add column if not exists size_sqm    numeric(8, 2),   -- unit size in square meters
  add column if not exists rental_aim  numeric(12, 2);  -- target rent per month (baht)
