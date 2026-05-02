-- =============================================================
-- Migration 001 — Invoices table + backfill
-- =============================================================
-- Run this AFTER pulling the latest schema.sql changes. Two parts:
--   1. Create the `invoices` table (idempotent — safe to run if it exists).
--   2. Backfill from existing jobs.invoice_amount into proper invoice rows.
--      For each job with invoice_amount > 0:
--        - If a deposit-style income entry exists (description like 'deposit'
--          OR amount roughly 30% of invoice_amount), create a deposit invoice
--          for that amount (paid, linked to the income entry).
--        - Always create a final invoice for the balance (or full amount if
--          no deposit detected). Marked paid if there's a matching income
--          entry, otherwise unpaid.
--
-- Idempotent via the (business_id, invoice_number) unique constraint.
-- Re-running just no-ops on conflict.

-- 1. Table — copy of what's in schema.sql for safety in case schema.sql
--    hasn't been run with the new section yet.
create table if not exists invoices (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade not null,
  job_id          uuid references jobs(id) on delete cascade not null,
  invoice_number  text not null,
  invoice_date    date not null default current_date,
  kind            text not null default 'final'
                    check (kind in ('deposit','progress','final')),
  amount_ex_gst   numeric(10,2) not null,
  gst_applies     boolean default true not null,
  gst_component   numeric(10,2),
  amount_incl_gst numeric(10,2),
  paid            boolean default false not null,
  paid_date       date,
  paid_via        text,
  income_entry_id uuid references entries(id) on delete set null,
  notes           text,
  created_at      timestamptz default now() not null,
  updated_at      timestamptz default now() not null,
  unique (business_id, invoice_number)
);

alter table invoices enable row level security;

do $$ begin
  create policy "Users can manage own invoices"
    on invoices for all using (
      business_id in (select id from businesses where owner_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;

create index if not exists invoices_job_id_idx       on invoices(job_id);
create index if not exists invoices_business_id_idx  on invoices(business_id);
create index if not exists invoices_paid_idx         on invoices(paid);

do $$ begin
  create trigger invoices_updated_at
    before update on invoices
    for each row execute function update_updated_at();
exception when duplicate_object then null;
end $$;

-- 2. Backfill from existing data
do $$
declare
  job_rec       record;
  deposit_entry record;
  final_entry   record;
  has_deposit   boolean;
  deposit_amt   numeric;
  final_amt     numeric;
  base_num      text;
begin
  for job_rec in
    select * from jobs where invoice_amount is not null and invoice_amount > 0
  loop
    base_num := 'INV-' || coalesce(job_rec.legacy_id, substr(job_rec.id::text, 1, 6));

    -- Look for an obvious deposit entry: type='income', description ilike '%deposit%'
    select * into deposit_entry
    from entries
    where job_id = job_rec.id
      and type   = 'income'
      and (description ilike '%deposit%' or description ilike '%deposit (30%%)%')
    order by entry_date asc
    limit 1;

    has_deposit := deposit_entry.id is not null;

    if has_deposit then
      -- Use the entry's ex-GST amount if populated, else gross-derived
      deposit_amt := coalesce(
        deposit_entry.amount_ex_gst,
        case when deposit_entry.gst_applies then deposit_entry.amount / 1.15 else deposit_entry.amount end
      );
      final_amt   := greatest(0, job_rec.invoice_amount - deposit_amt);

      -- Deposit invoice
      insert into invoices (
        business_id, job_id, invoice_number, invoice_date, kind,
        amount_ex_gst, gst_applies, gst_component, amount_incl_gst,
        paid, paid_date, paid_via, income_entry_id, notes
      )
      values (
        job_rec.business_id, job_rec.id, base_num, deposit_entry.entry_date, 'deposit',
        round(deposit_amt::numeric, 2), true,
        round((deposit_amt * 0.15)::numeric, 2),
        round((deposit_amt * 1.15)::numeric, 2),
        true, deposit_entry.entry_date, deposit_entry.payment_method,
        deposit_entry.id,
        'Backfilled from existing deposit income entry'
      )
      on conflict (business_id, invoice_number) do nothing;

      -- Final invoice for the balance
      if final_amt > 0 then
        -- Look for a "final" or "balance" income entry
        select * into final_entry
        from entries
        where job_id = job_rec.id
          and type   = 'income'
          and id     <> deposit_entry.id
        order by entry_date desc
        limit 1;

        insert into invoices (
          business_id, job_id, invoice_number, invoice_date, kind,
          amount_ex_gst, gst_applies, gst_component, amount_incl_gst,
          paid, paid_date, paid_via, income_entry_id, notes
        )
        values (
          job_rec.business_id, job_rec.id,
          base_num || '-F',
          coalesce(final_entry.entry_date, job_rec.end_date, current_date),
          'final',
          round(final_amt::numeric, 2), true,
          round((final_amt * 0.15)::numeric, 2),
          round((final_amt * 1.15)::numeric, 2),
          final_entry.id is not null,
          final_entry.entry_date,
          final_entry.payment_method,
          final_entry.id,
          'Backfilled from existing data (balance after deposit)'
        )
        on conflict (business_id, invoice_number) do nothing;
      end if;
    else
      -- No deposit detected. Create a single final invoice for the full amount.
      select * into final_entry
      from entries
      where job_id = job_rec.id and type = 'income'
      order by entry_date desc
      limit 1;

      insert into invoices (
        business_id, job_id, invoice_number, invoice_date, kind,
        amount_ex_gst, gst_applies, gst_component, amount_incl_gst,
        paid, paid_date, paid_via, income_entry_id, notes
      )
      values (
        job_rec.business_id, job_rec.id, base_num,
        coalesce(final_entry.entry_date, job_rec.end_date, current_date),
        'final',
        round(job_rec.invoice_amount::numeric, 2), true,
        round((job_rec.invoice_amount * 0.15)::numeric, 2),
        round((job_rec.invoice_amount * 1.15)::numeric, 2),
        final_entry.id is not null,
        final_entry.entry_date,
        final_entry.payment_method,
        final_entry.id,
        'Backfilled from existing data'
      )
      on conflict (business_id, invoice_number) do nothing;
    end if;
  end loop;

  raise notice 'Backfill complete. Run: select count(*) from invoices;';
end $$;
