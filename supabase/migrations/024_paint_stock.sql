-- =============================================================
-- Migration 024 — paint_stock: paint inventory on hand
-- =============================================================
-- Stock-on-hand tracking, deliberately SEPARATE from `materials`.
-- `materials` is a usage/purchase LOG (what went on which job, from
-- which bill) — rows are historical facts and never edited down.
-- `paint_stock` is CURRENT state (what's in the garage/van right now)
-- — rows are mutated constantly as paint gets used and bought.
-- Conflating the two would force either log-corruption or a derived
-- balance we can't trust (opening stock was never logged).
--
-- Simple by design ("litres per item", per Brad): one row per
-- product+colour, approximate litres remaining, where it lives.
-- Low-stock is DERIVED in the UI (litres <= 1 and not a test pot),
-- not stored — no flag to forget to update.
--
-- Future: materials inventory (tape, filler, sandpaper...) can either
-- widen `kind` or get its own table — decide when it's real.

create table if not exists paint_stock (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade not null,
  -- Product line, e.g. "Lumbersider", "Wash&Wear Low Sheen", "Woodsman".
  product       text not null,
  brand         text,
  -- Tint, e.g. "Flax Pod", "Half Tea". Null for untinted (sealers etc).
  color         text,
  kind          text not null default 'topcoat' check (kind in (
                  'topcoat','enamel','ceiling','primer_sealer','stain',
                  'test_pot','other'
                )),
  -- Approx litres remaining. Null = not tracked by volume
  -- (test pots, spray cans — presence is what matters).
  litres        numeric(6,2) check (litres is null or litres >= 0),
  location      text not null default 'garage' check (location in ('garage','van')),
  notes         text,
  created_at    timestamptz default now() not null,
  updated_at    timestamptz default now() not null
);

alter table paint_stock enable row level security;

create policy "Users can manage own paint stock"
  on paint_stock for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create index if not exists paint_stock_business_idx on paint_stock(business_id);
