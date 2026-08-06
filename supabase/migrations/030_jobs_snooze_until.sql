-- 030_jobs_snooze_until.sql
-- "Snooze" a lead — give it more time before it's worth chasing again.
--
-- While snooze_until is in the future, the Leads chase-list hides the lead
-- (it sits in a "Snoozed" drawer showing the wake date). On/after that date it
-- flows back into its normal bucket automatically. Deliberately separate from
-- follow_up_date (which drives the quote follow-up ladder) and dismissed_at
-- (park = indefinite). Nullable, no default, no backfill — existing rows read
-- as not snoozed. Owner-only feature, so no RLS / jobs_public change.

alter table jobs
  add column if not exists snooze_until date;
