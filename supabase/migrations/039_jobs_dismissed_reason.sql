-- 039_jobs_dismissed_reason.sql
-- Why a lead was parked ("not chasing").
--
-- Companion to 029_jobs_dismissed_at. Parking answers "is this off the
-- chase-list", this answers "why" — so that months later the Parked drawer
-- reads as a record rather than a pile of anonymous leads, and so patterns
-- ("half of these were out of area") are visible without opening each job.
--
-- Deliberately free-text rather than an enum: the UI offers preset chips
-- (out of area, too small, bad fit, gone quiet, price, timing) but Brad can
-- type anything, and a lead you chose not to chase has a much longer tail of
-- reasons than a lead you lost. Kept separate from `lost_reason` (which feeds
-- the win/loss stats) for the same reason `dismissed_at` is separate from
-- `status`: a parked lead is not a loss.
--
-- Nullable, no default, no backfill — existing parked rows simply have no
-- reason recorded, which the UI renders as "No reason noted". Optional at the
-- point of parking too: one tap parks, the reason is a second, skippable step.
-- Owner-only feature, so no RLS / jobs_public change.

alter table jobs
  add column if not exists dismissed_reason text;
