-- =============================================================
-- Migration 038 — off-site activities + jobless employee hours
-- =============================================================
-- Staff do paid work that isn't on a site: admin, the website, marketing,
-- training. Two things blocked logging it:
--
--   1. `entries.activity` has a CHECK constraint listing the on-site
--      activities plus quoting/admin. 'website' / 'marketing' /
--      'training' were rejected outright.
--
--   2. Migration 035's employee insert policy requires
--      `job_id is not null and user_assigned_to_job(job_id)`. Off-site
--      work has no job, so every one of these inserts would 42501.
--
-- Both are widened below. Jobless hours follow the app's existing
-- overhead convention (job_id null — the same shape Brad's own `[OH]`
-- entries use), so job-stats and the money math need no changes: an
-- entry with no job simply isn't attributed to one.
--
-- Payroll is unaffected in the right way: lib/payroll.ts sums hours by
-- `logged_by_user_id` regardless of job, so off-site hours are PAID like
-- any other — which is the point.

-- ── 1. Widen the activity vocabulary ────────────────────────────────────
-- The constraint is unnamed-by-convention in schema.sql ("entries_activity_check"
-- is what Postgres auto-names it). Drop by that name if present, then
-- re-add with the fuller list. `if exists` keeps this idempotent.
alter table entries drop constraint if exists entries_activity_check;

alter table entries add constraint entries_activity_check
  check (activity is null or activity in (
    -- on site
    'prep','painting','staining','wallpapering','stopping','primer',
    'repair','cleanup','travel',
    -- off site / office
    'quoting','admin','website','marketing','training'
  ));

-- ── 2. Let employees log hours with no job (off-site work) ──────────────
-- Replaces migration 035's version. An employee may now insert an hours
-- entry that either targets a job they're assigned to, OR targets no job
-- at all. Everything else is unchanged: still type='hours', still
-- self-attributed, still inside a business they belong to. They cannot
-- log hours against a job they're NOT on — that's the rule 035 added and
-- it stays.
drop policy if exists "employee inserts own hours" on entries;
create policy "employee inserts own hours"
  on entries for insert
  with check (
    type = 'hours'
    and logged_by_user_id = auth.uid()
    and business_id in (select public.current_user_business_ids())
    and (
      job_id is null
      or public.user_assigned_to_job(job_id)
    )
  );
