-- =============================================================
-- Migration 013 — Worker kind + helper hours on entries
-- =============================================================
-- Adds two columns to `entries` so logged-hours rows can identify WHO
-- did the work. Powers the blended-target hourly-rate gauge: each job's
-- gauge target becomes a weighted average of the per-tier rates based
-- on the actual hour-mix on that job.
--
-- ## Why on `entries` and not a separate table?
--
-- Logged-hours rows are the natural carrier. One entry = one shift of
-- work. If two people did the same shift, the convenience field
-- `helper_hours` lets Brad log "6h of mine + 6h of helper" as one row
-- — saves friction for the most common multi-worker case (him + Sophie).
-- For more complex setups (3 different people, different hours) he can
-- log separate entries with different `worker_kind` values.
--
-- ## Defaults
--
-- All existing entries default to `worker_kind = 'owner'` (Brad solo).
-- That keeps every historical hourly-rate calculation correct — they
-- were solo work — without a backfill pass. The places where this is
-- WRONG (e.g. J15 Malvern Rd where Sophie was on most of it) get
-- corrected as part of the per-job backfill story.

alter table entries
  -- WorkerKind enum lives in TypeScript (lib/types.ts). Free-form text
  -- here so the vocabulary can evolve without an ALTER TYPE migration.
  -- Values: owner | experienced | apprentice | helper | subcontractor
  add column if not exists worker_kind text default 'owner',

  -- Optional helper-hours on the same shift as the owner. Numeric so
  -- half-hours work ("Sophie helped for 4.5h"). Nullable for non-hours
  -- entries; treated as 0 by the gauge math when null.
  add column if not exists helper_hours numeric(6, 2);

-- Index on worker_kind for "show me all helper hours" reports later.
create index if not exists entries_worker_kind_idx
  on entries(worker_kind) where worker_kind is not null;
