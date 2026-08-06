-- =============================================================
-- Migration 031 — Address + client contact on schedule_items
-- =============================================================
-- Trims the "add site visit" form down to what's actually relevant for
-- a quote visit, and adds the fields that were missing: an address to
-- go to, and an optional way to reach the client.
--
-- Both are captured directly on the schedule_item rather than requiring
-- a linked Job, because a lot of site visits get booked *before* a Job
-- row exists (a lead rings up, Brad books the visit on the spot, the
-- Job gets created later during wrap-up).
--
--   - `location` (text): free-form address, same shape as jobs.location.
--     When a schedule_item is linked to a job AND has its own location,
--     the schedule_item's wins (it's what the user typed for this visit
--     specifically) — see app/(app)/schedule/page.tsx.
--   - `client_name` / `client_email` / `client_phone` (text): optional
--     contact details. None required — Brad can fill in just a phone
--     number and leave the rest blank.
--
-- All four nullable, default null. No backfill needed — existing rows
-- just fall back to their linked job's details (if any), same as before
-- this migration.

alter table schedule_items
  add column if not exists location text default null,
  add column if not exists client_name text default null,
  add column if not exists client_email text default null,
  add column if not exists client_phone text default null;

comment on column schedule_items.location is
  'Free-form site address for this schedule item. Takes priority over '
  'the linked job''s location (if any) when building calendar invites.';

comment on column schedule_items.client_name is
  'Optional client name captured directly on the schedule item — for '
  'site visits booked before a Job row exists. Not required.';

comment on column schedule_items.client_email is
  'Optional client email captured directly on the schedule item. Not required.';

comment on column schedule_items.client_phone is
  'Optional client phone captured directly on the schedule item. Not required.';
