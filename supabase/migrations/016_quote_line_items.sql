-- =============================================================
-- Migration 016 — quote_line_items table
-- =============================================================
-- The structured per-line records that make up a quote. The
-- existing `quotes` table holds the scope summary and totals;
-- this table holds the breakdown so the editor (and later the
-- AI drafter) has somewhere to put line-by-line numbers.
--
-- Why a separate table:
--   - 1:N relationship — a quote has many line items, and they
--     need to be re-ordered, edited individually, removed.
--   - Each line has its own unit (m², hours, days, each).
--   - JSONB-on-quotes was the alternative but loses you indexes,
--     check constraints, and per-row RLS — all of which we want
--     when this scales beyond Brad's single business.
--
-- The `total_ex_gst` is a generated column — Postgres computes
-- it from quantity * unit_price_ex_gst so the editor can't get
-- the line total wrong. Quote-level totals are still computed
-- in the app and stored back to quotes.base_amount_ex_gst on
-- save — the existing money pipeline downstream (job-stats,
-- tax-estimator etc) reads from there, so we can't bypass it.

create table if not exists quote_line_items (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid references businesses(id) on delete cascade not null,
  quote_id            uuid references quotes(id) on delete cascade not null,
  description         text not null,
  quantity            numeric(10,2) default 1 not null,
  -- Free-form unit so we can add 'lin m', 'rolls', etc. without a
  -- migration. UI presents a short shortlist (m², hours, days, each)
  -- but persistence accepts anything.
  unit                text,
  unit_price_ex_gst   numeric(10,2) default 0 not null,
  -- Generated column — Postgres keeps qty × unit_price in sync.
  -- Saves the app from having to recompute it on every read and
  -- guarantees the per-line total is internally consistent.
  total_ex_gst        numeric(12,2) generated always as (quantity * unit_price_ex_gst) stored,
  -- Position for ordering. The app keeps these contiguous 0,1,2,…
  -- but a gap-tolerant sort (order by position asc) means dropping
  -- one in the middle doesn't require renumbering the rest until
  -- the user explicitly reorders.
  position            smallint default 0 not null,
  created_at          timestamptz default now() not null,
  updated_at          timestamptz default now() not null
);

alter table quote_line_items enable row level security;

create policy "Users can manage own quote line items"
  on quote_line_items for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create trigger quote_line_items_updated_at
  before update on quote_line_items
  for each row execute function update_updated_at();

create index if not exists quote_line_items_quote_id_idx
  on quote_line_items(quote_id);
create index if not exists quote_line_items_business_id_idx
  on quote_line_items(business_id);
