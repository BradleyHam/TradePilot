-- 023_jobs_lead_date.sql
-- The date a lead/enquiry actually came in, distinct from created_at (the
-- row-creation date). Imported jobs all share one created_at, which made the
-- Leads "leads per week" chart spike on the import day. The Leads insights
-- bucket by lead_date, falling back to created_at when it's null, and it's
-- editable per job from the job detail sheet.

alter table jobs
  add column if not exists lead_date date;
