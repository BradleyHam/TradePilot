-- =============================================================
-- Migration 048 — Named crew (no login) on a booking
-- =============================================================
-- "Who's on it" could only ever name people with a Trade Pilot login,
-- because schedule_assignments.user_id is an FK to auth.users. That
-- covers Brad and his staff and nobody else — so a day where a
-- subcontractor is on site had no way to say so.
--
-- This is the same escape hatch `entries.worker_name` already uses for
-- logged hours (migration 046): a sub is a name on a day, not an entity
-- we manage. Free text, no FK, no login, no RLS surface of its own.
--
-- ## Why not nullable schedule_assignments.user_id
--
-- Every RLS gate in migration 035 keys on `user_id = auth.uid()`, and a
-- null user_id can never satisfy that — such a row would be inert for
-- visibility while still counting as "this booking has an override",
-- which would silently hide the booking from the staff who ARE on it.
-- Names live on the booking itself; assignments keep meaning exactly
-- what they meant.
--
-- Employees can read these names on bookings they're already allowed to
-- see (schedule_items policies unchanged) — useful: "you're on with
-- Kenneth on Thursday".

alter table schedule_items
  add column if not exists crew_names text[];
