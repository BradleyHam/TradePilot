-- =============================================================
-- Migration 046 — Worker name on hours entries
-- =============================================================
-- Adds a free-text name to `entries` so a "Someone else" hours row can
-- say WHO the someone was.
--
-- Context: an hours entry already carries `worker_kind` (the rate tier)
-- and `logged_by_user_id` (the payroll attribution, set when an employee
-- logs their own time or Brad logs it on their behalf). The gap is the
-- one-off worker with no login — most often a subcontractor. Those rows
-- could only ever say "Subcontractor", which is useless three months
-- later when Brad's trying to remember which sub was on that job.
--
-- Deliberately NOT a foreign key to a subcontractors table. A sub is a
-- name on a shift, not an entity we manage — a text field is the whole
-- feature and it costs nothing to type.
--
-- Only meaningful when `logged_by_user_id` is null and `worker_kind` is
-- not 'owner'. Null everywhere else, including every historical row.

alter table entries
  add column if not exists worker_name text;
