-- =============================================================
-- Migration 013 — ics_downloaded flag on schedule_items
-- =============================================================
-- Tracks whether the user downloaded the .ics calendar invite for a
-- given schedule item. Drives the "Reminders set" vs "Add to calendar"
-- badge on quote_visit rows.
--
-- Defaults to false. NOT a hard signal that the user imported the file
-- into their calendar (the browser can't tell us that) — just that the
-- download happened. The UI labels it honestly.

alter table schedule_items
  add column if not exists ics_downloaded boolean not null default false;

-- No index needed — this column is only read alongside other fields
-- on rows we're already fetching for a single business. The page-level
-- query is already business-scoped via RLS.
