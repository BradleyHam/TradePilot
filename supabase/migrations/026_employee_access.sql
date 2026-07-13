-- =============================================================
-- Migration 026 — employee access + money-blindness (Phase 2)
-- =============================================================
-- Builds on 025 (business_members). Gives an `employee` member a NARROW,
-- money-blind slice of the data, WITHOUT touching any of the owner's
-- existing policies.
--
-- ## Why the owner's policies are left completely alone
--
-- Every existing table policy is
--   business_id in (select id from businesses where owner_id = auth.uid())
-- i.e. "only the business OWNER". An employee has a different auth.uid()
-- and is NOT the owner_id, so those policies ALREADY deny employees
-- everything (invoices, quotes, materials, bank_transactions, settings,
-- paint_stock, job_imports, base jobs, etc). Money-blindness for those
-- tables therefore needs NO change — it's already the default.
--
-- This migration only ADDS permissive policies granting employees the
-- specific things they DO need. Postgres OR-combines permissive policies,
-- so the owner keeps full access via the untouched owner policies and the
-- employee gets exactly the slice granted below — nothing more.
--
-- What an employee gets:
--   • read their own business row (so the app loads)
--   • read jobs through `jobs_public` — a money-FREE view (no
--     estimated_value / quote_amount / invoice_amount). Base `jobs` stays
--     owner-only, so a direct `select * from jobs` returns them nothing.
--   • insert / read / edit / delete ONLY the `hours` entries they logged
--     themselves (attributed via new column `logged_by_user_id`).
--   • read the business's job bookings (their work schedule). Read-only.
-- Everything financial remains invisible.

-- ── Attribution column: who logged an hours entry ───────────────────────
-- Nullable; existing (owner-logged) rows stay null and are unaffected —
-- the owner policy doesn't look at it. Employee hours MUST carry the
-- logger's uid (enforced by the insert policy below).
alter table entries
  add column if not exists logged_by_user_id uuid references auth.users(id);

create index if not exists entries_logged_by_idx
  on entries(logged_by_user_id) where logged_by_user_id is not null;

-- ── Helper: business ids the current user is a member of (any role) ─────
-- SECURITY DEFINER so it can read business_members from inside other
-- tables' policies without tripping business_members' own RLS (no
-- recursion). It only ever returns the caller's OWN memberships.
create or replace function public.current_user_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select business_id from business_members where user_id = auth.uid()
$$;

grant execute on function public.current_user_business_ids() to authenticated;

-- ── businesses: let any member read their business row ──────────────────
-- ADDITIVE — the existing owner select/insert/update policies stay. Needed
-- so an employee's app can resolve which business they belong to.
drop policy if exists "members read their business" on businesses;
create policy "members read their business"
  on businesses for select
  using (id in (select public.current_user_business_ids()));

-- ── jobs_public: money-FREE window onto jobs, for employees ─────────────
-- Deliberately a SECURITY DEFINER view (default): it bypasses the
-- owner-only RLS on base `jobs`, and its own WHERE clause is the guard —
-- it returns only jobs in businesses the caller is a member of, and only
-- non-financial columns. Base `jobs` is untouched (still owner-only), so
-- employees cannot reach the money columns directly.
-- NOTE: `notes` is included because job scope lives there. Don't put
-- pricing in job notes if employees shouldn't see it.
drop view if exists public.jobs_public;
create view public.jobs_public as
  select
    id, business_id, legacy_id, name,
    client_name, client_email, client_phone, location,
    status, start_date, end_date, follow_up_date, lead_date,
    notes, created_at, updated_at
  from public.jobs
  where business_id in (select public.current_user_business_ids());

grant select on public.jobs_public to authenticated;

-- ── entries: employee may touch ONLY their own hours ────────────────────
-- Permissive policies, OR'd with the untouched owner policy. Each requires
-- type='hours' + self-attribution + business membership. An employee can
-- therefore never read an expense/income/bill, never see someone else's
-- hours, and never attribute an entry to anyone but themselves.
drop policy if exists "employee reads own hours" on entries;
create policy "employee reads own hours"
  on entries for select
  using (
    type = 'hours'
    and logged_by_user_id = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

drop policy if exists "employee inserts own hours" on entries;
create policy "employee inserts own hours"
  on entries for insert
  with check (
    type = 'hours'
    and logged_by_user_id = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

drop policy if exists "employee updates own hours" on entries;
create policy "employee updates own hours"
  on entries for update
  using (
    type = 'hours'
    and logged_by_user_id = auth.uid()
    and business_id in (select public.current_user_business_ids())
  )
  with check (
    type = 'hours'
    and logged_by_user_id = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

drop policy if exists "employee deletes own hours" on entries;
create policy "employee deletes own hours"
  on entries for delete
  using (
    type = 'hours'
    and logged_by_user_id = auth.uid()
    and business_id in (select public.current_user_business_ids())
  );

-- ── schedule_items: employee may READ the business's job bookings ───────
-- Read-only, job_booking rows only (no money-bearing bill_due/invoice_due
-- reminders). Lets Suzie see where she's booked to work.
drop policy if exists "employee reads job bookings" on schedule_items;
create policy "employee reads job bookings"
  on schedule_items for select
  using (
    type = 'job_booking'
    and business_id in (select public.current_user_business_ids())
  );
