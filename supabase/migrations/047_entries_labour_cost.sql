-- =============================================================
-- Migration 047 — Labour cost rate + billed flag on hours entries
-- =============================================================
-- Lets an hours entry carry what that person COSTS, so the app can
-- accrue subcontractor / one-off-helper labour from the day the work
-- happened instead of waiting for their invoice to arrive.
--
-- ## Why this isn't the existing worker_rate_* settings
--
-- `worker_rate_subcontractor` (settings) is a CHARGE-OUT TARGET — what
-- an hour of sub time should EARN, used to size the job's hourly-rate
-- gauge. This is the other side: what the hour COSTS Brad. Different
-- number, different direction, and it varies per sub, so it lives on
-- the entry rather than in settings.
--
-- ## Which rows accrue
--
-- Only hours rows with NO logged_by_user_id (nobody on payroll — their
-- cost already comes through pay runs, and accruing it here would
-- double-count wages), a non-owner worker_kind, and a rate set. A rate
-- of null means "I don't know what this cost" — those rows accrue
-- nothing rather than inventing a number.
--
-- ## Retiring the accrual
--
-- When the sub's actual invoice arrives it becomes a normal bill entry.
-- At that point the accrued hours must stop counting or the cost lands
-- twice: `labour_billed` flips true (via the prompt on bill confirm, or
-- the tick on the entry itself) and `labour_bill_entry_id` points at the
-- bill that covered it, so the link survives a later look-back.
--
-- Accruals are a MANAGEMENT figure only. Nothing here touches the GST
-- return or the income-tax estimate — those stay payments-basis, which
-- is correct for Brad's registration.

alter table entries
  -- Ex-GST cost per hour for this person on this shift. Ex-GST because
  -- every financial calc in the app is ex-GST (golden rule).
  add column if not exists worker_cost_rate numeric(8, 2),

  -- True once the sub has actually invoiced these hours. Stops the
  -- accrual so the real bill is the only thing counting.
  add column if not exists labour_billed boolean not null default false,

  -- Which bill entry covered these hours. Nullable: the manual tick sets
  -- labour_billed without a specific bill.
  add column if not exists labour_bill_entry_id uuid references entries(id) on delete set null;

-- "What sub labour is still unbilled?" — the accrual query.
create index if not exists entries_unbilled_labour_idx
  on entries(business_id, entry_date)
  where type = 'hours' and labour_billed = false and worker_cost_rate is not null;
