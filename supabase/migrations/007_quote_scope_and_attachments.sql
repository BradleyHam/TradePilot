-- =============================================================
-- Migration 007 — Quote scope fields + quote attachments
-- =============================================================
-- Adds the structured-data fields the future quoting assistant needs:
--   m² by zone, prep level, surface type, client signals.
-- Also adds a separate `quote_attachments` table linking quotes to
-- council plans + before/after photos uploaded to a new Storage
-- bucket (set up separately — see SQL block printed in chat).
--
-- All new columns are nullable so existing imported quote rows from the
-- legacy Finances sheet aren't disturbed. The importer in
-- scripts/import-projects.ts populates them where data is available.
--
-- prep_level uses the same enum vocabulary as jobs.prep_level (defined
-- as a free-form text in lib/types.ts PrepLevel). Kept as text + CHECK
-- here rather than a database-level enum so we can evolve the vocabulary
-- without an ALTER TYPE migration later.

alter table quotes
  add column if not exists surface_area_m2_by_zone jsonb,
  -- Example shape: {"weatherboards": 120, "soffits": 30, "garage_door": 8}
  add column if not exists prep_level text
    check (prep_level in ('light', 'medium', 'heavy', 'full-strip')),
  add column if not exists surface_type text,
  -- Free-form for now: "weatherboard", "cedar", "linea", "stucco", etc.
  -- Evolves to an enum if a clear short list emerges.
  add column if not exists client_signals jsonb,
  -- Example shape: {"priceSensitivity": "mid", "urgency": "low",
  --                 "decisionMakerPresent": true, "leadSource": "referral"}
  add column if not exists import_source_path text;
  -- Folder path the project importer pulled this row from, for traceability.

create index if not exists quotes_import_source_path_idx
  on quotes(import_source_path) where import_source_path is not null;

-- ── Quote attachments ──────────────────────────────────────────────────────
-- One row per attached file (plan PDF, photo, etc) linked to a quote.
-- Storage objects live under the `quote-attachments` Storage bucket at the
-- path `{businessId}/{quoteId}/{uuid}.{ext}`. The `storage_path` column
-- stores the object path, NEVER a signed URL — signed URLs expire and
-- are regenerated client-side on demand.
create table if not exists quote_attachments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade not null,
  quote_id      uuid references quotes(id) on delete cascade not null,
  kind          text not null check (kind in (
                  'plan',        -- council building plan / floor plan / elevation
                  'before_photo','after_photo',
                  'scope_photo', -- site visit photos showing the work area
                  'quote_pdf',   -- the sent quote document itself
                  'other'
                )),
  storage_path  text not null,
  file_name     text,
  page_count    integer,
  -- Optional structured fields the council-plan parser fills in once it runs.
  parsed_m2_by_zone jsonb,
  parsed_confidence text check (parsed_confidence in ('high','medium','low')),
  created_at    timestamptz default now() not null
);

alter table quote_attachments enable row level security;

create policy "Users can manage own quote attachments"
  on quote_attachments for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create index if not exists quote_attachments_quote_id_idx
  on quote_attachments(quote_id);
create index if not exists quote_attachments_business_id_idx
  on quote_attachments(business_id);
