-- ─────────────────────────────────────────────────────────────
-- 0003_family_data_prep.sql — prep for inserting family data
-- ─────────────────────────────────────────────────────────────

-- Owners can exist before they've ever messaged the bot.
-- line_user_id is backfilled when each family member first chats;
-- uniqueness still holds for the IDs that are present.
alter table landlords alter column line_user_id drop not null;
alter table landlords drop constraint landlords_line_user_id_key;
create unique index landlords_line_user_id_key
  on landlords(line_user_id)
  where line_user_id is not null;

-- Free-text memo for manually entered (historical) transactions.
alter table transactions add column note text;

-- Pin categories to the documented list so dashboard groupings
-- don't fragment across 6 people's data entry.
alter table transactions add constraint transactions_category_check
  check (category in (
    'rent', 'common_fee', 'agency', 'maintenance',
    'tax', 'utilities', 'insurance', 'other'
  ));
