-- =============================================================
-- Migration 008 — Project archive import staging
-- =============================================================
-- One row per folder discovered in Brad's /projects archive by the
-- scripts/import-projects.ts --apply step. Holds the suggested job
-- match + classified files + LLM-parsed quote data BEFORE it lands in
-- the real jobs/quotes/quote_attachments tables. The user reviews each
-- row in the "Imports to review" flag on Home and commits it as
-- link/create/skip, which copies (or doesn't) into the real tables.
--
-- This is the same draft-then-confirm pattern as bill drafts but kept
-- in a separate table rather than a flag on the real tables, so the
-- audit pass we did for !isDraft doesn't have to grow another set of
-- guards. Real jobs/quotes/quote_attachments only contain real data.
--
-- Attachments staged during --apply live in the existing
-- `quote-attachments` Storage bucket under a `_pending/{importId}/`
-- prefix. On commit, they're moved (or copied) under
-- `{businessId}/{quoteId}/` to follow the canonical convention.

create table if not exists job_imports (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid references businesses(id) on delete cascade not null,

  -- Source: where the folder lives on disk + a stable identifier for it.
  source_path              text not null,         -- absolute filesystem path, audit only
  folder_name              text not null,         -- basename, displayed to user

  -- Matching: what the dry-run thought the right job was.
  suggested_job_id         uuid references jobs(id) on delete set null,
  suggested_legacy_id      text,
  suggested_label          text,
  match_confidence         text check (match_confidence in ('high','medium','low','none')),
  match_source             text,                  -- e.g. "J-ID via INV-J7-FINAL.pdf" or "fuzzy 30"

  -- Files: structured summary of what's in the folder + storage prefix
  -- where uploaded attachments are staged.
  files_summary            jsonb not null,        -- { plan: 2, quote_pdf: 1, ... }
  attachments_storage_prefix text,                -- e.g. "_pending/{importId}"

  -- Parsed: LLM-extracted quote fields if a quote PDF was present.
  parsed_data              jsonb,                 -- ParsedQuote shape — see lib/types.ts

  -- Workflow status — pending until the user commits the row.
  status                   text not null default 'pending'
                             check (status in ('pending','committed','skipped')),
  -- What action was applied at commit-time. Set when status flips off pending.
  commit_action            text check (commit_action in ('link','create','skip')),
  commit_target_job_id     uuid references jobs(id) on delete set null,
  commit_target_quote_id   uuid references quotes(id) on delete set null,
  committed_at             timestamptz,

  notes                    text,
  created_at               timestamptz default now() not null,
  updated_at               timestamptz default now() not null,

  -- Re-running --apply against the same folder updates rather than duplicates.
  unique (business_id, source_path)
);

alter table job_imports enable row level security;

create policy "Users can manage own job imports"
  on job_imports for all using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create trigger job_imports_updated_at
  before update on job_imports
  for each row execute function update_updated_at();

-- Pending imports get queried often by the Home flag; index for speed.
create index if not exists job_imports_pending_idx
  on job_imports(business_id) where status = 'pending';
create index if not exists job_imports_status_idx
  on job_imports(status);
