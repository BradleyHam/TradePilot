-- =============================================================
-- Migration 020 — Skip reason on schedule_items
-- =============================================================
-- Lets Brad mark a scheduled day as "didn't work today" with a reason.
-- Common cases for an outdoor painter: rained off, sick, client
-- postponed, materials didn't arrive.
--
-- A skipped day is NOT the same as a completed day:
--   - `completed = true`  → "I worked it"  (clears Overdue, gauge counts it)
--   - `skip_reason_kind ≠ null` → "I couldn't work it" (clears Overdue,
--     stays on the calendar as a faded card with the reason)
--
-- Two columns instead of one:
--   - `skip_reason_kind` (text): the picked chip, e.g. 'rained_off'.
--     Kept as free-form text rather than a Postgres enum so the
--     vocabulary can evolve without an ALTER TYPE migration. The
--     TypeScript layer (lib/types.ts ScheduleSkipReasonKind) is the
--     source of truth for the allowed values.
--   - `skip_reason` (text): optional free-form note. Always shown when
--     `skip_reason_kind = 'other'`; optional for the other kinds.
--
-- Both nullable, both default null. No backfill needed — every existing
-- row is implicitly "not skipped".

alter table schedule_items
  add column if not exists skip_reason_kind text default null,
  add column if not exists skip_reason text default null;

-- Comment is documentation that ships with the schema — visible in
-- the Supabase dashboard and via `\d+ schedule_items` in psql.
comment on column schedule_items.skip_reason_kind is
  'When set, the day was skipped (not worked) with the given reason kind. '
  'Allowed values controlled by lib/types.ts ScheduleSkipReasonKind '
  '(rained_off, sick, client_postponed, other). null = not skipped.';

comment on column schedule_items.skip_reason is
  'Optional free-form note attached to a skipped day. Required when '
  'skip_reason_kind = "other", optional otherwise.';
