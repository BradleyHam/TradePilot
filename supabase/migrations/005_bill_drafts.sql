-- =============================================================
-- Migration 005 — Bill drafts (PDF upload + LLM extraction)
-- =============================================================
-- Adds four columns to `entries` so a supplier bill can land in the
-- system as a *draft* — extracted from an uploaded PDF but not yet
-- counted against expenses/GST until Brad confirms it on Home.
--
-- Columns:
--   is_draft           — true while awaiting Brad's confirmation. Every
--                        bill-aggregating query in the app must filter
--                        these out (see the audit pass in commit 1).
--                        Default false so existing 1000+ entries stay
--                        confirmed; only new uploads opt in.
--   bill_pdf_url       — path inside the `bill-pdfs` Supabase Storage
--                        bucket. We store the *object path*, not a signed
--                        URL — URLs expire, paths don't. Signed URLs are
--                        generated client-side on demand for previewing.
--   parser_confidence  — coarse high/medium/low signal from the LLM call
--                        so the Confirm UI can hint at "you really should
--                        double-check this one".
--   parser_raw         — full JSON the parser emitted, for debugging /
--                        future re-processing if we improve the prompt.
--
-- Storage bucket + RLS policies live in a separate SQL block (see chat
-- output) because they touch the `storage.*` schema and must be run via
-- the Supabase SQL editor with the right ownership.

alter table entries
  add column if not exists is_draft boolean not null default false,
  add column if not exists bill_pdf_url text,
  add column if not exists parser_confidence text
    check (parser_confidence in ('high', 'medium', 'low')),
  add column if not exists parser_raw jsonb;

-- Partial index — most entries are NOT drafts, so a regular index would
-- be wasteful. The draft set is tiny (only unconfirmed bills) and
-- queried often by the Home flag.
create index if not exists entries_is_draft_idx
  on entries(is_draft) where is_draft = true;
