-- =============================================================
-- Migration 025 — business_members (multi-user foundation)
-- =============================================================
-- PHASE 1 of the employee-accounts feature. This migration is PURELY
-- ADDITIVE: it creates one new table + its own RLS, and backfills Brad
-- as the owner. It deliberately does NOT touch any existing table's RLS
-- policies, so the current single-user app behaves EXACTLY as before
-- after applying it. The money-blindness rewrite (denying employees the
-- money tables, employee jobs view) is Phase 2 in a later migration.
--
-- ## Model
--
-- One row per (business, user). role ∈ owner | employee.
--   - owner    → Brad. Full access. Backfilled from businesses.owner_id.
--   - employee → e.g. Suzie. Money-blind (enforced in Phase 2). Logs her
--                own hours, sees her schedule + job details minus money.
-- worker_kind mirrors entries.worker_kind so an employee's logged hours
-- can default to the right tier (Suzie = 'helper').
--
-- ## RLS design (no recursion)
--
-- business_members' own policies key off businesses.owner_id (a DIFFERENT
-- table), never off business_members itself, so there's no policy
-- recursion. A member can read their own row; the business owner can read
-- and manage every membership row in their business.

create table if not exists business_members (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id) on delete cascade not null,
  user_id      uuid references auth.users(id) on delete cascade not null,
  -- Enum lives in TypeScript (lib/types.ts MemberRole). Free-form text +
  -- check here so the vocabulary can grow without an ALTER TYPE.
  role         text not null default 'employee' check (role in ('owner', 'employee')),
  display_name text,
  -- Values: owner | experienced | apprentice | helper | subcontractor
  worker_kind  text,
  created_at   timestamptz not null default now(),
  unique (business_id, user_id)
);

create index if not exists business_members_user_idx
  on business_members(user_id);
create index if not exists business_members_business_idx
  on business_members(business_id);

alter table business_members enable row level security;

-- A member can read their OWN membership row(s).
drop policy if exists "member reads own membership" on business_members;
create policy "member reads own membership"
  on business_members for select
  using (user_id = auth.uid());

-- The business OWNER can read every membership in their business.
-- Keys off businesses.owner_id (not this table) → no recursion.
drop policy if exists "owner reads all memberships" on business_members;
create policy "owner reads all memberships"
  on business_members for select
  using (business_id in (select id from businesses where owner_id = auth.uid()));

-- The business OWNER can insert / update / delete memberships in their
-- business (drives the in-app "Add employee" screen in Phase 4).
drop policy if exists "owner manages memberships" on business_members;
create policy "owner manages memberships"
  on business_members for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

-- Backfill: every existing business owner becomes an 'owner' member.
-- Idempotent via the unique(business_id, user_id) + on conflict.
insert into business_members (business_id, user_id, role, display_name, worker_kind)
select b.id, b.owner_id, 'owner', 'Brad', 'owner'
from businesses b
on conflict (business_id, user_id) do nothing;
