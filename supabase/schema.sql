-- TradePilot Database Schema
-- Run this in your Supabase SQL editor

-- Enable RLS
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;

-- ============================================================
-- USERS (handled by Supabase Auth)
-- ============================================================

-- ============================================================
-- BUSINESSES
-- ============================================================
create table if not exists businesses (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users(id) on delete cascade not null,
  name        text not null,
  industry    text,
  created_at  timestamptz default now() not null
);

alter table businesses enable row level security;

create policy "Users can view own business"
  on businesses for select using (auth.uid() = owner_id);

create policy "Users can insert own business"
  on businesses for insert with check (auth.uid() = owner_id);

create policy "Users can update own business"
  on businesses for update using (auth.uid() = owner_id);

-- ============================================================
-- JOBS
-- ============================================================
-- legacy_id holds the J1/J2/... identifiers from the Finances sheet so
-- imported records can still be referenced by their old IDs.
create table if not exists jobs (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade not null,
  legacy_id       text unique,
  name            text not null,
  client_name     text not null,
  client_email    text,
  client_phone    text,
  location        text,
  status          text not null default 'lead'
                    check (status in ('lead','quoted','accepted','booked','in-progress','completed','invoiced','paid','lost')),
  estimated_value numeric(10,2),
  quote_amount    numeric(10,2),
  invoice_amount  numeric(10,2),
  start_date      date,
  end_date        date,
  follow_up_date  date,
  notes           text,
  created_at      timestamptz default now() not null,
  updated_at      timestamptz default now() not null
);

alter table jobs enable row level security;

create policy "Users can manage own jobs"
  on jobs for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger jobs_updated_at
  before update on jobs
  for each row execute function update_updated_at();

-- ============================================================
-- ENTRIES
-- ============================================================
create table if not exists entries (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade not null,
  job_id          uuid references jobs(id) on delete set null,
  type            text not null check (type in ('expense','income','hours','enquiry','quote','bill','note')),
  category        text check (category in ('labour','paint','materials','tools','fuel','vehicle','admin','software','marketing','subcontractor','other')),
  amount          numeric(10,2),
  hours           numeric(6,2),
  activity        text check (activity in ('prep','painting','staining','wallpapering','stopping','primer','repair','cleanup','travel','quoting','admin')),
  supplier        text,
  payment_method  text,
  -- GST: stored gross in `amount`. ex-GST/gst components persisted for
  -- historical accuracy when GST rate changes.
  gst_applies     boolean default true not null,
  amount_ex_gst   numeric(10,2),
  gst_component   numeric(10,2),
  description     text not null,
  entry_date      date not null default current_date,
  due_date        date,
  -- Bill-specific fields (only used when type='bill')
  company         text,
  paid            boolean default false not null,
  paid_date       date,
  payment_ref     text,
  created_at      timestamptz default now() not null
);

alter table entries enable row level security;

create policy "Users can manage own entries"
  on entries for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

-- Index for common queries
create index entries_business_id_idx on entries(business_id);
create index entries_job_id_idx on entries(job_id);
create index entries_entry_date_idx on entries(entry_date desc);
create index entries_type_idx on entries(type);

-- ============================================================
-- SCHEDULE ITEMS
-- ============================================================
create table if not exists schedule_items (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade not null,
  job_id      uuid references jobs(id) on delete set null,
  type        text not null check (type in ('job_booking','quote_visit','follow_up','bill_due','invoice_due','reminder')),
  title       text not null,
  date        date not null,
  start_time  time,
  end_time    time,
  notes       text,
  completed   boolean default false not null,
  created_at  timestamptz default now() not null
);

alter table schedule_items enable row level security;

create policy "Users can manage own schedule items"
  on schedule_items for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create index schedule_items_date_idx on schedule_items(date, completed);
create index schedule_items_business_id_idx on schedule_items(business_id);

-- ============================================================
-- MATERIALS & PAINT
-- ============================================================
-- Mirrors the Materials & Paint tab in the Finances sheet. A materials row
-- usually pairs with an expense `entry`; we don't enforce the link, but
-- `entry_id` is provided for when the importer or UI knows it.
create table if not exists materials (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade not null,
  job_id        uuid references jobs(id) on delete set null,
  entry_id      uuid references entries(id) on delete set null,
  used_on       date,
  product_type  text check (product_type in (
                  'paint','primer','stain','filler','tape','sandpaper',
                  'brush','roller','drop_sheet','caulk','wallpaper','other'
                )),
  brand         text,
  product_name  text,
  color         text,
  finish        text check (finish in (
                  'matte','flat','low_sheen','satin','semi_gloss','gloss','eggshell'
                )),
  quantity      numeric(10,2),
  unit          text check (unit in ('litres','rolls','sheets','each','metres','kg')),
  cost          numeric(10,2),
  supplier      text,
  area          text,
  notes         text,
  created_at    timestamptz default now() not null
);

alter table materials enable row level security;

create policy "Users can manage own materials"
  on materials for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create index materials_business_id_idx on materials(business_id);
create index materials_job_id_idx on materials(job_id);

-- ============================================================
-- QUOTES
-- ============================================================
-- Mirrors the Quotes tab. A quote can optionally link to an enquiry (we
-- don't yet model enquiries as a first-class table; for now just store the
-- legacy enquiry_id text reference) and to a job once won.
create table if not exists quotes (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid references businesses(id) on delete cascade not null,
  legacy_id             text unique,
  legacy_enquiry_id     text,
  job_id                uuid references jobs(id) on delete set null,
  date_sent             date,
  client_name           text,
  job_address           text,
  job_type              text,
  scope_summary         text,
  base_amount_ex_gst    numeric(10,2),
  option_amount_ex_gst  numeric(10,2),
  total_amount_incl_gst numeric(10,2),
  status                text check (status in (
                          'draft','sent','accepted','declined','expired','superseded'
                        )),
  won_amount_ex_gst     numeric(10,2),
  variance_amount       numeric(10,2),
  variance_percent      numeric(6,2),
  notes                 text,
  created_at            timestamptz default now() not null,
  updated_at            timestamptz default now() not null
);

alter table quotes enable row level security;

create policy "Users can manage own quotes"
  on quotes for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create trigger quotes_updated_at
  before update on quotes
  for each row execute function update_updated_at();

create index quotes_business_id_idx on quotes(business_id);
create index quotes_job_id_idx on quotes(job_id);

-- ============================================================
-- SETTINGS
-- ============================================================
-- Per-business key/value config (e.g. gst_mode, gst_rate, gst_effective_date).
create table if not exists settings (
  business_id uuid references businesses(id) on delete cascade not null,
  key         text not null,
  value       text,
  notes       text,
  updated_at  timestamptz default now() not null,
  primary key (business_id, key)
);

alter table settings enable row level security;

create policy "Users can manage own settings"
  on settings for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create trigger settings_updated_at
  before update on settings
  for each row execute function update_updated_at();

-- ============================================================
-- INVOICES
-- ============================================================
-- A job can have many invoices: deposit, optional progress, final.
-- jobs.invoice_amount remains the agreed total work value (quote +
-- variations); invoices document what's been billed against it.
-- Marking an invoice paid auto-creates an income entry and links back
-- via income_entry_id so the cash-basis side stays in sync.
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
  -- Link to the auto-created income entry (or any existing entry the
  -- migration matched up). Nulled if the entry is later deleted; the
  -- invoice survives.
  income_entry_id uuid references entries(id) on delete set null,

  notes           text,
  created_at      timestamptz default now() not null,
  updated_at      timestamptz default now() not null,

  -- Per-business unique invoice numbers
  unique (business_id, invoice_number)
);

alter table invoices enable row level security;

create policy "Users can manage own invoices"
  on invoices for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create index invoices_job_id_idx on invoices(job_id);
create index invoices_business_id_idx on invoices(business_id);
create index invoices_paid_idx on invoices(paid);

create trigger invoices_updated_at
  before update on invoices
  for each row execute function update_updated_at();

-- ============================================================
-- INDEXES on entries.legacy/GST for import + dashboard queries
-- ============================================================
create index if not exists jobs_legacy_id_idx on jobs(legacy_id);
create index if not exists entries_gst_applies_idx on entries(gst_applies);
