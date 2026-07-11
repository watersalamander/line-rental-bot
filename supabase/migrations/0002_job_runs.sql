-- ─────────────────────────────────────────────────────────────
-- 0002_job_runs.sql — push-dedupe ledger for Phase 5 cron
-- ─────────────────────────────────────────────────────────────
-- One row per side-effect that must happen at most once, e.g.
--   remind:<invoiceId>:<YYYY-MM-DD>   group reminder sent that day
--   digest:<landlordId>:<YYYY-MM-DD>  landlord digest sent that day
--   summary:<landlordId>:<YYYY-MM>    monthly summary pushed
-- A job claims its key (insert) BEFORE sending; a unique-violation
-- means another run already sent it. Survives server restarts,
-- which an in-memory guard would not (tsx watch restarts a lot).

create table job_runs (
  job_key text primary key,
  ran_at  timestamptz not null default now()
);
