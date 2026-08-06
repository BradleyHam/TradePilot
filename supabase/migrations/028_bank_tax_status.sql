-- =============================================================
-- Migration 028 — Tax / IRD payment classification for bank txns
-- =============================================================
-- Payments to Inland Revenue (income tax, GST, PAYE, penalties) are NOT
-- deductible business expenses:
--   - Income tax is an appropriation of profit, non-deductible (s DB 1).
--   - GST paid is a pass-through liability settlement, not an expense.
--   - PAYE remitted is already captured as gross wages; the remittance
--     itself isn't a second expense.
--   - Penalties are non-deductible; use-of-money interest is separate.
--
-- So a tax payment must NOT become an `entries` expense row (that would
-- overstate deductions and understate profit). We handle it exactly like
-- an internal transfer / personal spend: a terminal bank_transactions
-- status that creates no entry, keeping it out of all P&L + GST math.
--
-- `tax_kind` records the sub-type so the Money page can show a
-- "Paid to IRD" breakdown. Nullable — a plain 'tax' with no sub-type
-- is valid.

-- 1. Extend the status check to allow 'tax'. The original constraint
--    (migration 002) was inline + unnamed, so Postgres named it
--    `bank_transactions_status_check`. Drop-if-exists then re-add named.
alter table bank_transactions
  drop constraint if exists bank_transactions_status_check;

alter table bank_transactions
  add constraint bank_transactions_status_check
  check (status in ('unreconciled','matched','ignored','personal','tax'));

-- 2. Sub-type of the IRD payment. NULL is allowed (checks pass on NULL),
--    so existing rows and un-subtyped tax payments are fine.
alter table bank_transactions
  add column if not exists tax_kind text
  check (tax_kind in ('income_tax','gst','paye','penalty','other'));
