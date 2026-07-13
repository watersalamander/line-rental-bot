-- ─────────────────────────────────────────────────────────────
-- 0004_deposits_and_pool.sql — historical-data realities
-- ─────────────────────────────────────────────────────────────

-- 'deposit' category: security deposits received / refunded are
-- real money movements but are not rent income — keeping them
-- separate keeps the dashboard's income numbers honest.
alter table transactions drop constraint transactions_category_check;
alter table transactions add constraint transactions_category_check
  check (category in (
    'rent', 'common_fee', 'agency', 'maintenance',
    'tax', 'utilities', 'insurance', 'deposit', 'other'
  ));

-- Pool-level transactions (e.g. family spending paid from the
-- common pool) belong to no individual owner: landlord_id and
-- property_id both null marks a pool row.
alter table transactions alter column landlord_id drop not null;
