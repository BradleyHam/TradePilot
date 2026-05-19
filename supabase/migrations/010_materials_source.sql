-- =============================================================
-- Migration 010 — materials.source: distinguish bill vs overhead
-- =============================================================
-- Materials currently come from one path: confirming a supplier bill
-- with per-line job allocation. That path creates a row per line item
-- linked to the bill via `entry_id`.
--
-- Adding a second path: "I used something from my van that I already
-- owned (overhead)". These rows are entered directly from the
-- JobDetailSheet, have NO `entry_id`, and represent attribution only —
-- there's no fresh cash outflow because the original purchase already
-- counted under overhead at the time.
--
-- We need to be able to tell the two apart so we don't double-count.
-- The rule:
--   * source='bill'     → derived from a confirmed bill line.
--                         The entry it's linked to is what drives
--                         business-wide P&L. The materials row is
--                         metadata about the line item.
--   * source='overhead' → user-entered usage, no entry behind it.
--                         Counts toward the JOB'S material cost (so
--                         per-job profit reflects it) but does NOT
--                         count in business-wide expenses (because
--                         the original overhead purchase already did).
--
-- Default = 'bill' so existing rows continue to behave exactly as they
-- did. Idempotent — re-runs are safe.

alter table materials
  add column if not exists source text not null default 'bill'
    check (source in ('bill','overhead'));

-- Index for the per-job lookups that will filter by source.
create index if not exists materials_source_idx
  on materials(source);
