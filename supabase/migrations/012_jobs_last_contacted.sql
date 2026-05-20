-- =============================================================
-- Migration 012 — last_contacted_date on jobs
-- =============================================================
-- Tracks the last time Brad actively touched a lead/client. Drives
-- the "days since last contact" badge on the Leads chase-list, which
-- is the primary signal for "who needs chasing right now?".
--
-- Bumped by:
--   - "Mark contacted" button on the Leads page (manual log).
--   - When a quote is issued against the job (future hook).
--   - When the user replies via the (future) inbound-email integration.
--
-- Nullable. Existing rows stay null; the UI falls back to created_at
-- when this is null so the chase-list still renders sensible numbers
-- on day one without a backfill.

alter table jobs
  add column if not exists last_contacted_date timestamptz;

-- Partial index — only open leads (lead/quoted) ever sort by this
-- column on the chase-list, so we don't pay the index cost for the
-- thousands of completed/paid rows that'll never be queried by it.
create index if not exists jobs_last_contacted_open_idx
  on jobs (last_contacted_date)
  where status in ('lead', 'quoted');
