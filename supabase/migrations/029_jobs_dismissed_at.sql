-- 029_jobs_dismissed_at.sql
-- "Park" a lead: remove it from the Leads chase-list without marking it lost.
--
-- When Brad decides he doesn't want to chase a lead anymore, we don't want to
-- delete the record (he may want it later) and we don't want to mark it 'lost'
-- (that would count it against his win/loss conversion stats — a lead he chose
-- not to pursue isn't a loss to a competitor).
--
-- So: keep status as-is ('lead'/'quoted') and stamp dismissed_at. The Leads
-- page hides any job with dismissed_at set and offers a "Parked" section to
-- restore it (clears the column). Nullable, no default, no backfill — existing
-- rows read as active. Owner-only feature, so no RLS / jobs_public change.

alter table jobs
  add column if not exists dismissed_at timestamptz;
