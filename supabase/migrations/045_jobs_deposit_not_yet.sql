-- 045_jobs_deposit_not_yet.sql
-- "Not yet" on the Home "Deposits to send" flag.
--
-- An accepted job with no deposit invoice nags on Home until the deposit
-- goes out. Sometimes that's right but not *now* (dates not locked in,
-- client asked to hold, sorting it in person) — and sometimes there's no
-- deposit coming at all (small job, trusted client, tender/progress-claim
-- terms). "Not yet" records the reason and quiets the flag:
--
--   deposit_not_yet_reason  the pill Brad picked:
--                           'dates_not_locked' | 'client_hold'
--                           | 'in_person' | 'no_deposit'
--   deposit_snooze_until    local date (YYYY-MM-DD). While in the future
--                           the job is hidden from the flag, then flows
--                           back automatically. NULL + reason 'no_deposit'
--                           = hidden for good (until the reason is cleared
--                           or the job leaves 'accepted').
--
-- Same shape as the lead snooze (030) — nullable, no default, no backfill,
-- owner-only feature so no RLS / jobs_public change. Issuing the deposit
-- still clears the flag the normal way; these columns just quiet it.

alter table jobs
  add column if not exists deposit_not_yet_reason text,
  add column if not exists deposit_snooze_until date;
