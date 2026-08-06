-- =============================================================
-- Migration 032 — pay_runs (employee payroll tracking)
-- =============================================================
-- Tracks each fortnightly wage payment to an employee (Suzie), plus the
-- two IRD follow-ups that hang off every pay day:
--   - ei_filed   → payday employment information filed in myIR
--                  (due within 2 working days of the pay day).
--   - paye_paid  → the PAYE for the month containing paid_date has been
--                  remitted to IRD (small-employer schedule: due the 20th
--                  of the FOLLOWING month).
--
-- A pay_run row is created only when Brad marks a period paid — pending
-- periods are computed on the fly in lib/payroll.ts from the cycle anchor,
-- so there's nothing to pre-seed or keep in sync.
--
-- The gross wage lands in the books via a linked `entries` expense row
-- (category 'labour', no GST — wages are outside the GST net), created in
-- the same store flow (`addPayRun`, mirroring markInvoicePaid). PAYE
-- remittances themselves are NOT expenses — they reconcile as bank
-- transactions with status='tax', tax_kind='paye' (the gross wage already
-- carries the deduction; see lib/types.ts TaxPaymentKind).
--
-- RLS: OWNER-ONLY, matching the money-blindness design — employees never
-- read pay_runs in v1 (their own payslip view can be a later, narrower
-- policy). Policies key off businesses.owner_id like every other money
-- table; nothing keys off business_members, so no recursion.

create table if not exists pay_runs (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid references businesses(id) on delete cascade not null,
  -- Which team member this pay run is for. SET NULL (not cascade) so
  -- revoking an employee's access never deletes wage history — the
  -- denormalised employee_name keeps the row meaningful.
  member_id        uuid references business_members(id) on delete set null,
  employee_name    text not null,
  period_start     date not null,
  period_end       date not null,
  -- Snapshot of the hours the gross was computed from (own + helper),
  -- kept for the IRD "pay matches timesheets" evidence trail.
  hours            numeric,
  rate             numeric,
  gross            numeric not null,
  -- Optional — from the IRD PAYE calculator. Recorded so the monthly
  -- "pay PAYE by the 20th" reminder can show a real figure.
  paye             numeric,
  net              numeric,
  paid             boolean not null default false,
  paid_date        date,
  ei_filed         boolean not null default false,
  paye_paid        boolean not null default false,
  -- The linked wages expense entry (created when marked paid).
  expense_entry_id uuid references entries(id) on delete set null,
  notes            text,
  created_at       timestamptz not null default now(),
  -- One pay run per employee per period.
  unique (business_id, member_id, period_start)
);

create index if not exists pay_runs_business_idx on pay_runs(business_id);
create index if not exists pay_runs_period_idx   on pay_runs(business_id, period_start);

alter table pay_runs enable row level security;

drop policy if exists "owner manages pay runs" on pay_runs;
create policy "owner manages pay runs"
  on pay_runs for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));
