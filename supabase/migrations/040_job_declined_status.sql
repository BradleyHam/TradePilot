-- 040_job_declined_status.sql
-- "Declined" — work Brad turned down — becomes a first-class job status,
-- and REPLACES the old "park" mechanism from 029 / 039.
--
-- ## Why
--
-- 'lost' was doing two unrelated jobs. A job you quoted and were outbid on is
-- a competitive loss and belongs in the win-rate. A job you turned down —
-- Queenstown, new-build, too small, wrong fit — never was a contest, and
-- counting it as a loss makes the conversion rate read pessimistically about
-- a decision Brad made on purpose. 018's LostReason already smuggled two
-- "we declined it" values ('too-far', 'wrong-fit') into the loss enum for
-- exactly this reason; this migration stops smuggling and gives the concept
-- its own status.
--
-- ## Why this also retires "park"
--
-- 029 (dismissed_at) + 039 (dismissed_reason) built a parallel mechanism that
-- answered the same question — "off the chase-list, but not a loss" — while
-- leaving `status` alone. Two concepts for one idea meant two places to look
-- and two ways to say the same thing. Declining is now the single answer, so
-- the park columns are RENAMED (not dropped) into the declined vocabulary and
-- every parked lead is migrated to status='declined'. No data is lost.
--
-- ## Recoverability is preserved
--
-- Park's best property was that it was reversible — "Put back on the list".
-- Moving to a status would normally destroy the lead's place in the pipeline,
-- so we stamp `declined_from_status` on the way in. Restoring puts the job
-- back exactly where it was (a declined quote returns to 'quoted', not 'lead').

-- ── 1. Widen the status check ─────────────────────────────────────────────
-- schema.sql declares this inline, so Postgres named it jobs_status_check.
alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check
  check (status in (
    'lead','quoted','accepted','booked','in-progress',
    'completed','invoiced','paid','lost','declined'
  ));

-- ── 2. Rename the park columns into the declined vocabulary ───────────────
-- Guarded so re-running is safe, and so a database that never got 029/039
-- still ends up with the right shape. `jobs_public` does not select either
-- column (both are owner-only), so the view needs no rebuild.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'dismissed_at'
  ) then
    alter table jobs rename column dismissed_at to declined_at;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'dismissed_reason'
  ) then
    alter table jobs rename column dismissed_reason to decline_reason;
  end if;
end $$;

alter table jobs
  add column if not exists declined_at    timestamptz,
  -- Free-text note. Also the landing spot for legacy `dismissed_reason`
  -- values migrated off the old park flow, which were free text too.
  add column if not exists decline_reason text,
  -- The preset chips, multi-select: a job is often turned down for more
  -- than one reason at once ("out of area" AND "too busy"), and forcing a
  -- single pick threw away half the answer. text[] mirrors the existing
  -- `work_types` / `scope_included` convention rather than comma-joining
  -- into decline_reason, so the values stay queryable for a future
  -- "why am I turning work down?" breakdown.
  add column if not exists decline_reasons text[],
  -- The status the job held when it was declined, so "Put it back" can
  -- restore it precisely. Free text rather than a FK/enum — it mirrors
  -- `status` and the vocabulary evolves in the app, not the schema.
  add column if not exists declined_from_status text;

-- ── 3. Migrate every parked lead to the declined status ───────────────────
-- Parked rows kept their original status ('lead'/'quoted'); that value is
-- exactly what declined_from_status is for. Scoped to those two statuses
-- because parking was only ever offered on open leads — anything else with
-- a declined_at stamp is unexpected and is left alone rather than moved.
update jobs
   set declined_from_status = coalesce(declined_from_status, status),
       status               = 'declined'
 where declined_at is not null
   and status in ('lead', 'quoted');

-- ── 4. Index for the Declined drawer (newest-declined first) ──────────────
create index if not exists jobs_declined_at_idx
  on jobs(declined_at desc) where declined_at is not null;
