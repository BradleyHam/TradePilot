-- =============================================================
-- Migration 050 — employee shift close-outs + photo shortlist
-- =============================================================
-- Hours stay in entries (payroll's source of truth) and photos stay in
-- shift_photos. This table is only the small operational handoff Brad
-- needs at the end of a day: all good, needs attention, or ready for him
-- to review. One report per person, job and work date; saving again edits
-- the same close-out instead of creating duplicates.

create table if not exists shift_reports (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade not null,
  job_id      uuid references jobs(id) on delete cascade not null,
  uploaded_by uuid references auth.users(id) on delete cascade not null,
  work_date   date not null default current_date,
  status      text not null default 'all_good'
              check (status in ('all_good', 'needs_attention', 'ready_for_review')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (job_id, uploaded_by, work_date)
);

create index if not exists shift_reports_business_date_idx
  on shift_reports(business_id, work_date desc);
create index if not exists shift_reports_user_date_idx
  on shift_reports(uploaded_by, work_date desc);

drop trigger if exists shift_reports_updated_at on shift_reports;
create trigger shift_reports_updated_at
  before update on shift_reports
  for each row execute function update_updated_at();

alter table shift_reports enable row level security;

-- Owner sees and manages every report for their business.
drop policy if exists "owner manages shift reports" on shift_reports;
create policy "owner manages shift reports"
  on shift_reports for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

-- Employees only see and write their own close-outs, and only for jobs
-- they are assigned to. No prices, invoices, other people's hours, or
-- other employees' reports become visible through this table.
drop policy if exists "employee reads own shift reports" on shift_reports;
create policy "employee reads own shift reports"
  on shift_reports for select
  using (
    uploaded_by = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

drop policy if exists "employee inserts own shift reports" on shift_reports;
create policy "employee inserts own shift reports"
  on shift_reports for insert
  with check (
    uploaded_by = auth.uid()
    and business_id in (select public.current_user_business_ids())
    and public.user_assigned_to_job(job_id)
  );

drop policy if exists "employee updates own shift reports" on shift_reports;
create policy "employee updates own shift reports"
  on shift_reports for update
  using (
    uploaded_by = auth.uid()
    and business_id in (select public.current_user_business_ids())
  )
  with check (
    uploaded_by = auth.uid()
    and business_id in (select public.current_user_business_ids())
    and public.user_assigned_to_job(job_id)
  );

-- Brad can star useful staff photos for the existing marketing workflow.
-- Employees never see or control this flag; their photos remain private by
-- default and nothing is published automatically.
alter table shift_photos
  add column if not exists marketing_candidate boolean not null default false;

