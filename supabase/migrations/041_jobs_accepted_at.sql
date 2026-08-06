-- 041_jobs_accepted_at.sql
-- Stamp the moment a job is accepted, so "how long from quote to yes?" is answerable.
--
-- ## Why
--
-- Acceptance was the one pipeline transition that left no trace. `updated_at`
-- looked like a stand-in — the home page's `depositsToSend` already sorts by it
-- as a proxy for "recently accepted" — but the jobs_updated_at trigger rewrites
-- it on EVERY edit, so the value decays the moment Brad adds a photo or fixes a
-- phone number. A job accepted in March and touched in July reads as accepted in
-- July. That is worse than no data, because it is silently wrong.
--
-- `accepted_at` is written once, on the transition into 'accepted', and never
-- again. Paired with `quotes.date_sent` (already stamped by mark-as-quoted) it
-- gives the time-to-decision metric that 018's `quotes.outcome_date` comment
-- anticipated but nothing ever populated.
--
-- ## Why on jobs, not quotes
--
-- `quotes.status` and `jobs.status` drift independently — nothing syncs a quote
-- to 'accepted' when the job is. The job is the row the app actually moves, so
-- the job is where the truth lives. Quotes stay the source for date_sent only.
--
-- ## Why it is not exposed to staff
--
-- jobs_public (037) enumerates its columns, and accepted_at is owner-only
-- commercial data. Deliberately omitted, so no view rebuild is needed here.

-- ── 1. The column ─────────────────────────────────────────────────────────
alter table jobs
  add column if not exists accepted_at timestamptz;

comment on column jobs.accepted_at is
  'When the job first moved to status=accepted. Written once and never overwritten — unlike updated_at. Paired with quotes.date_sent to measure quote-to-acceptance time. Owner-only: not exposed via jobs_public.';

-- ── 2. Backfill from updated_at ───────────────────────────────────────────
-- Approximate, and knowingly so. For jobs already at or past acceptance the
-- alternative is a permanent hole in the history, and updated_at is at least
-- bounded above by "sometime after it was accepted". Clamped to created_at so
-- a corrupted row can never claim to have been accepted before it existed.
--
-- Every status from 'accepted' onward implies the job WAS accepted at some
-- point. 'lost' and 'declined' are excluded — they never got there. 'lead' and
-- 'quoted' are excluded for the same reason.
--
-- `where accepted_at is null` makes this re-runnable and, more importantly,
-- means a real stamp recorded by the app is never overwritten by the guess.
update jobs
   set accepted_at = greatest(updated_at, created_at)
 where accepted_at is null
   and status in ('accepted','booked','in-progress','completed','invoiced','paid');

-- ── 3. Index ──────────────────────────────────────────────────────────────
-- Partial: only accepted jobs carry the stamp, and the analytics panel reads
-- them newest-first over a date window.
create index if not exists jobs_accepted_at_idx
  on jobs(accepted_at desc) where accepted_at is not null;
