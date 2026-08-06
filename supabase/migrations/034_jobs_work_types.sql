-- =============================================================
-- Migration 034 — Multi-select job type (jobs.work_types)
-- =============================================================
-- `jobs.work_type` is a single value, which forced a real problem into a
-- lie: a renovation that's genuinely interior AND exterior had to be
-- tagged `mixed`, and `mixed` tells you nothing. You can't filter for it,
-- you can't benchmark against it, and the quote drafter's "find me
-- similar past jobs" comparison treats every mixed job as comparable to
-- every other mixed job — a cedar-and-roof restain matched against an
-- interior-and-wallpaper fitout.
--
-- This adds `work_types text[]`: the full set of types on the job.
--
-- `work_type` (singular) STAYS, and stays populated. Every existing
-- reader — the leads filter, lead insights, the marketing service
-- mapper, website publish, the quote drafter's comparison set — keeps
-- reading it untouched. The app now writes it as a DERIVED summary:
--
--     work_types = ['interior']              → work_type = 'interior'
--     work_types = ['interior','exterior']   → work_type = 'mixed'
--     work_types = []                        → work_type = null
--
-- So `mixed` is no longer something you pick; it's what "more than one"
-- is called. The chip disappears from the UI, and any job already
-- tagged `mixed` keeps that value until it's re-tagged (see backfill).
--
-- Backfill: every job with a work_type gets a single-element array —
-- INCLUDING the existing `mixed` rows, which become ['mixed']. That's
-- deliberate. We don't know which types a historical `mixed` job
-- actually covered, and inventing an answer would corrupt the
-- benchmarks this column exists to feed. They stay honest-but-vague
-- until someone opens the job and re-tags it, at which point the real
-- values replace the placeholder.
--
-- No check constraint on the array contents: WorkType is validated in
-- TypeScript, and a DB-level constraint would mean a migration every
-- time a new type is added (same reasoning as lead_source).

alter table jobs
  add column if not exists work_types text[] default null;

-- Seed the array from the existing singular column. `where work_types
-- is null` keeps this re-runnable — a second run won't clobber arrays
-- the app has since written.
update jobs
   set work_types = array[work_type]
 where work_type is not null
   and work_types is null;

comment on column jobs.work_types is
  'Full set of work types on this job (interior/exterior/cedar/wallpaper/roof). '
  'jobs.work_type is kept in sync as a derived summary: the single value when '
  'there is one, ''mixed'' when there are several. Read work_types when you care '
  'about what the job actually involves; read work_type for one-bucket grouping.';
