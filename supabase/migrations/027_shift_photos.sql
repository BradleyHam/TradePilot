-- =============================================================
-- Migration 027 — shift_photos (site photos logged by staff)
-- =============================================================
-- Lets an employee attach photos to a shift when they log hours (and the
-- owner attach them too). Photos are tied to a job + date, not strictly to
-- an hours entry, so the capture flow never has to wait for the optimistic
-- entry insert to get a real id.
--
-- Money-blind-safe: photos carry no financial data, and the employee
-- policies only ever let a person touch their OWN uploads.

create table if not exists shift_photos (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id) on delete cascade not null,
  job_id       uuid references jobs(id) on delete cascade,
  -- Optional link to the hours entry the photo was logged alongside.
  entry_id     uuid references entries(id) on delete set null,
  uploaded_by  uuid references auth.users(id),
  taken_on     date not null default current_date,
  storage_path text not null,   -- object in the 'shift-photos' bucket
  caption      text,
  created_at   timestamptz not null default now()
);

create index if not exists shift_photos_job_idx on shift_photos(job_id);
create index if not exists shift_photos_business_idx on shift_photos(business_id);

alter table shift_photos enable row level security;

-- Owner: full access to their business's photos (matches every other table).
drop policy if exists "owner manages shift photos" on shift_photos;
create policy "owner manages shift photos"
  on shift_photos for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

-- Employee: may insert / read / delete ONLY their own uploads, in a
-- business they belong to. (current_user_business_ids() from migration 026.)
drop policy if exists "employee inserts own shift photos" on shift_photos;
create policy "employee inserts own shift photos"
  on shift_photos for insert
  with check (
    uploaded_by = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

drop policy if exists "employee reads own shift photos" on shift_photos;
create policy "employee reads own shift photos"
  on shift_photos for select
  using (
    uploaded_by = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

drop policy if exists "employee deletes own shift photos" on shift_photos;
create policy "employee deletes own shift photos"
  on shift_photos for delete
  using (
    uploaded_by = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

-- ── Storage bucket (private) ────────────────────────────────────────────
-- Path convention: {businessId}/{jobId}/{uuid}__{filename}
insert into storage.buckets (id, name, public)
values ('shift-photos', 'shift-photos', false)
on conflict (id) do nothing;

-- Read: any MEMBER of the business the photo belongs to (owner + employees).
-- Business is the first path segment. Photos aren't money, so business-level
-- read is acceptable and keeps the policy simple.
drop policy if exists "members read shift photos" on storage.objects;
create policy "members read shift photos"
  on storage.objects for select using (
    bucket_id = 'shift-photos'
    and (split_part(name, '/', 1))::uuid in (select public.current_user_business_ids())
  );

-- Write: members can upload into their own business's folder.
drop policy if exists "members upload shift photos" on storage.objects;
create policy "members upload shift photos"
  on storage.objects for insert with check (
    bucket_id = 'shift-photos'
    and (split_part(name, '/', 1))::uuid in (select public.current_user_business_ids())
  );

drop policy if exists "members delete shift photos" on storage.objects;
create policy "members delete shift photos"
  on storage.objects for delete using (
    bucket_id = 'shift-photos'
    and (split_part(name, '/', 1))::uuid in (select public.current_user_business_ids())
  );
