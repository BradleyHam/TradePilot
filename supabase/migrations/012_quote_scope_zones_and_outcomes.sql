-- =============================================================
-- Migration 012 — Quote scope_zones + richer outcome capture
-- =============================================================
-- Foundation for the cost engine (lib/pricing/cost-engine.ts) and
-- the win-rate model that comes after it.
--
-- ## Why add scope_zones when surface_area_m2_by_zone already exists?
--
-- Migration 007 added `surface_area_m2_by_zone` as a flat
-- `{ zoneName: m² }` map. That works for the project importer (which
-- only knows m² per labelled zone) but the cost engine needs richer
-- structure per zone: surface type + work kind (new vs repaint) + prep
-- level + measurement unit (m² OR LM OR each) + per-zone notes.
--
-- Rather than break the existing column (still used by the importer),
-- we add `scope_zones` jsonb alongside it. The cost engine prefers
-- scope_zones if populated; falls back to surface_area_m2_by_zone for
-- legacy/imported rows.
--
-- ## Outcome capture
--
-- The recommendation layer (future) needs to learn from outcomes:
-- did this quote win? At what price? Did a competitor undercut?
-- We add `competitor_price_ex_gst` + `outcome_date` + `outcome_reason`
-- to capture this without forcing it (all nullable).
--
-- `outcome_reason` is free-form for now — same evolve-without-migration
-- pattern as work_type / prep_level.

alter table quotes
  -- Per-zone structured scope. Shape (TypeScript-mirrored):
  --   [{
  --      name: "North elevation cedar",
  --      surface: "cedar",          -- ScopeSurface enum from cost-engine.ts
  --      kind: "repaint",           -- 'new' | 'repaint'
  --      prep: "medium",            -- PrepLevel enum
  --      m2: 60,                    -- exactly one of m2 / LM / count populated
  --      LM: null,
  --      count: null,
  --      notes: "Some soft spots near the deck — flag for closer look"
  --   }, ...]
  -- We store as jsonb (not a separate table) because the array is
  -- always read together with the quote — a join would be pure cost.
  add column if not exists scope_zones jsonb,

  -- What did a competing painter quote for the same job? Optional —
  -- customer often tells us informally ("got one for $9k"). Powers the
  -- recommendation layer's market-rate signal.
  add column if not exists competitor_price_ex_gst numeric(10, 2),

  -- When the outcome was decided (won / lost / ghosted). Distinct from
  -- date_sent (when the quote went out) and from updated_at (which
  -- ticks for every edit). Used to compute time-to-decision metrics.
  add column if not exists outcome_date date,

  -- Free-form reason text — supersedes a fixed enum so the vocabulary
  -- can evolve. Maps loosely to LostReason / WonReason types in
  -- lib/types.ts but isn't constrained at the DB level.
  add column if not exists outcome_reason text;

-- Index on outcome_date for time-series win-rate queries (future).
create index if not exists quotes_outcome_date_idx
  on quotes(outcome_date) where outcome_date is not null;

-- Index on competitor presence for "show me jobs where we knew the
-- competitor price" queries.
create index if not exists quotes_competitor_price_idx
  on quotes(competitor_price_ex_gst) where competitor_price_ex_gst is not null;
