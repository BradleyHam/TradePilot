-- =============================================================
-- Migration 002 — Bank transactions table for CSV reconciliation
-- =============================================================
-- Each imported CSV row becomes a `bank_transactions` row. We hash
-- (date + amount + description + bank_account) so re-importing the same
-- file is idempotent — duplicate rows just no-op on the unique constraint.
--
-- Once a bank row is reconciled to an `entries` row, both sides hold the
-- link: bank_transaction.entry_id and entries.bank_transaction_id.
-- This means:
--   - Deleting the entry leaves the bank row visible but unlinked
--     (re-reconcilable).
--   - Deleting the bank row clears the entry's link but leaves the entry.

-- Bank accounts (one user can have several — operating + savings + tax)
create table if not exists bank_accounts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id) on delete cascade not null,
  name         text not null,                 -- e.g. "BNZ Operating"
  bank         text,                          -- 'BNZ', 'ANZ', etc — for parser hints
  account_no   text,                          -- '02-0312-0183213-000', optional
  is_personal  boolean default false not null, -- if true, all txns default to "personal" / ignored
  created_at   timestamptz default now() not null
);

alter table bank_accounts enable row level security;
do $$ begin
  create policy "Users can manage own bank_accounts"
    on bank_accounts for all using (
      business_id in (select id from businesses where owner_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

-- Bank transactions — one row per CSV line
create table if not exists bank_transactions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade not null,
  bank_account_id uuid references bank_accounts(id) on delete cascade,
  txn_date        date not null,
  -- Money: positive for credits (income), negative for debits (expenses).
  -- Matches BNZ's CSV: -112.06 for a debit, +5140.50 for a credit.
  amount          numeric(12,2) not null,
  -- Raw fields direct from the CSV (BNZ-shaped; other banks map to these)
  payee           text,                        -- BNZ "Payee" / merchant name
  particulars     text,                        -- BNZ "Particulars"
  code            text,                        -- BNZ "Code"
  reference       text,                        -- BNZ "Reference"
  tran_type       text,                        -- 'POS' | 'FT' | 'BP' | 'D/D' etc
  other_party_account text,                    -- the other side of the txn
  -- Derived for display: combination of payee + particulars + reference,
  -- pre-computed at import time so the UI doesn't have to.
  description     text not null,
  -- Idempotency hash so re-imports don't duplicate
  fingerprint     text not null,
  -- Reconciliation state
  status          text not null default 'unreconciled'
                    check (status in ('unreconciled','matched','ignored','personal')),
  entry_id        uuid references entries(id) on delete set null,
  notes           text,
  imported_at     timestamptz default now() not null,
  unique (business_id, fingerprint)
);

alter table bank_transactions enable row level security;
do $$ begin
  create policy "Users can manage own bank_transactions"
    on bank_transactions for all using (
      business_id in (select id from businesses where owner_id = auth.uid())
    );
exception when duplicate_object then null; end $$;

create index if not exists bank_transactions_business_id_idx on bank_transactions(business_id);
create index if not exists bank_transactions_status_idx       on bank_transactions(status);
create index if not exists bank_transactions_txn_date_idx     on bank_transactions(txn_date desc);

-- Add the back-link on entries
alter table entries
  add column if not exists bank_transaction_id uuid
    references bank_transactions(id) on delete set null;

create index if not exists entries_bank_transaction_id_idx on entries(bank_transaction_id);
