-- =============================================================
-- Migration 035 — job + booking assignments (who works where)
-- =============================================================
-- Brad is hiring. Until now every employee saw every booked job (fine
-- with one helper, wrong with a crew). This migration adds:
--
--   • job_assignments      — "these people are on this job" (job level)
--   • schedule_assignments — per-BOOKING override ("just Tom on Thursday")
--
-- Effective assignees for a booking:
--   if the booking has ANY schedule_assignments rows → exactly those people
--   else → everyone in job_assignments for the booking's job.
--
-- Employee visibility becomes STRICT (Brad's choice, July 2026): an
-- employee only sees jobs + bookings they're assigned to, and can only
-- log hours against jobs they're assigned to. Unassigned = invisible.
--
-- Owner policies are untouched (additive pattern from 026). Existing
-- employees (Suzie) are backfilled onto all currently-workable jobs so
-- nothing changes for her the moment this runs.

-- ── Tables ──────────────────────────────────────────────────────────────

create table if not exists job_assignments (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade not null,
  job_id      uuid references jobs(id) on delete cascade not null,
  user_id     uuid references auth.users(id) on delete cascade not null,
  created_at  timestamptz not null default now(),
  unique (job_id, user_id)
);

create index if not exists job_assignments_job_idx on job_assignments(job_id);
create index if not exists job_assignments_user_idx on job_assignments(user_id);
create index if not exists job_assignments_business_idx on job_assignments(business_id);

create table if not exists schedule_assignments (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid references businesses(id) on delete cascade not null,
  schedule_item_id uuid references schedule_items(id) on delete cascade not null,
  user_id          uuid references auth.users(id) on delete cascade not null,
  created_at       timestamptz not null default now(),
  unique (schedule_item_id, user_id)
);

create index if not exists schedule_assignments_item_idx on schedule_assignments(schedule_item_id);
create index if not exists schedule_assignments_user_idx on schedule_assignments(user_id);
create index if not exists schedule_assignments_business_idx on schedule_assignments(business_id);

-- ── RLS ─────────────────────────────────────────────────────────────────

alter table job_assignments enable row level security;
alter table schedule_assignments enable row level security;

-- Owner: full control (standard owner pattern).
drop policy if exists "owner manages job assignments" on job_assignments;
create policy "owner manages job assignments"
  on job_assignments for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

drop policy if exists "owner manages schedule assignments" on schedule_assignments;
create policy "owner manages schedule assignments"
  on schedule_assignments for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

-- Employee: read ONLY their own assignment rows (enough for the app to
-- know what they're on; they never see who else is assigned via these
-- tables directly).
drop policy if exists "member reads own job assignments" on job_assignments;
create policy "member reads own job assignments"
  on job_assignments for select
  using (user_id = auth.uid());

drop policy if exists "member reads own schedule assignments" on schedule_assignments;
create policy "member reads own schedule assignments"
  on schedule_assignments for select
  using (user_id = auth.uid());

-- ── Helper fns (SECURITY DEFINER) ───────────────────────────────────────
-- Needed because policy subqueries run under the CALLER's RLS: an
-- employee can't see other people's schedule_assignments rows, so a plain
-- "does this booking have an override?" check would silently lie to them.

-- Is the current user assigned to this job at all (job level, or day-
-- assigned to any booking of it)?
create or replace function public.user_assigned_to_job(j uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from job_assignments
    where job_id = j and user_id = auth.uid()
  ) or exists (
    select 1
    from schedule_assignments sa
    join schedule_items si on si.id = sa.schedule_item_id
    where si.job_id = j and sa.user_id = auth.uid()
  );
$$;

-- Is the current user on this specific booking?
-- Override rows win; otherwise fall back to job-level assignment.
create or replace function public.user_assigned_to_booking(item_id uuid, item_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from schedule_assignments where schedule_item_id = item_id)
      then exists (
        select 1 from schedule_assignments
        where schedule_item_id = item_id and user_id = auth.uid()
      )
    else exists (
      select 1 from job_assignments
      where job_id = item_job_id and user_id = auth.uid()
    )
  end;
$$;

grant execute on function public.user_assigned_to_job(uuid) to authenticated;
grant execute on function public.user_assigned_to_booking(uuid, uuid) to authenticated;

-- ── schedule_items: employee read tightened to ASSIGNED bookings ────────
-- Replaces 026's "employee reads job bookings" (which was business-wide).
drop policy if exists "employee reads job bookings" on schedule_items;
create policy "employee reads job bookings"
  on schedule_items for select
  using (
    type = 'job_booking'
    and business_id in (select public.current_user_business_ids())
    and public.user_assigned_to_booking(id, job_id)
  );

-- ── jobs_public: employees see only ASSIGNED jobs ───────────────────────
-- Same money-free column list as 026; the WHERE gains the assignment
-- check. Owners still see every job through it (they read base `jobs`
-- anyway, but keep the view permissive for them so nothing owner-side
-- can break).
drop view if exists public.jobs_public;
create view public.jobs_public as
  select
    id, business_id, legacy_id, name,
    client_name, client_email, client_phone, location,
    status, start_date, end_date, follow_up_date, lead_date,
    notes, created_at, updated_at
  from public.jobs
  where business_id in (select public.current_user_business_ids())
    and (
      business_id in (select id from businesses where owner_id = auth.uid())
      or public.user_assigned_to_job(id)
    );

grant select on public.jobs_public to authenticated;

-- ── entries: employee hours must target an assigned job ─────────────────
-- Replaces 026's insert policy. Read/update/delete of their OWN existing
-- hours stay as-is (un-assigning someone must never strand or hide the
-- hours they already logged).
drop policy if exists "employee inserts own hours" on entries;
create policy "employee inserts own hours"
  on entries for insert
  with check (
    type = 'hours'
    and logged_by_user_id = auth.uid()
    and business_id in (select public.current_user_business_ids())
    and job_id is not null
    and public.user_assigned_to_job(job_id)
  );

-- ── Backfill: current employees keep access to workable jobs ────────────
-- Suzie currently sees every active job; without this she'd see nothing
-- until Brad assigns her. Idempotent via on conflict.
insert into job_assignments (business_id, job_id, user_id)
select j.business_id, j.id, bm.user_id
from jobs j
join business_members bm
  on bm.business_id = j.business_id and bm.role = 'employee'
where j.status in ('accepted', 'booked', 'in-progress')
on conflict (job_id, user_id) do nothing;
