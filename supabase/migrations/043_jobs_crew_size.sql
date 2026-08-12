-- =============================================================
-- Migration 043 — Crew size on jobs
-- =============================================================
-- `days_estimate` (migration 015 era) was ambiguous: 3 days solo and
-- 3 days with Suzie on site are the same number but double the labour
-- cost. `crew_size` disambiguates — days_estimate is now documented as
-- WORKING days on the tools for THIS crew, and days × crew = the
-- person-days figure the AI quote drafter prices labour from.
--
-- Nullable on purpose: legacy rows and quick wrap-ups won't have it,
-- and a missing value reads as "probably solo, unverified" rather
-- than a fake 1. Range check is generous (Brad + partner + the odd
-- subbie tops out well under 6).

alter table jobs
  add column if not exists crew_size int default null
  check (crew_size is null or crew_size between 1 and 6);

comment on column jobs.crew_size is
  'People on the tools for days_estimate. days_estimate × crew_size = '
  'person-days of labour. Null = not captured (assume solo, unverified).';
