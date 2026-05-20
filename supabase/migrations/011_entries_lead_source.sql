-- =============================================================
-- Migration 011 — Lead source on entries
-- =============================================================
-- Captures where an enquiry came from at the moment it's logged.
-- Only set on type='enquiry' rows; null everywhere else. Mirrors
-- the values in jobs.source (migration 003) so the two columns can
-- be reconciled later when a lead converts into a job.
--
-- Values used by the UI today:
--   website   — painterswanaka.co.nz contact form
--   referral  — word of mouth
--   phone     — direct phone call
--   email     — direct email
--   gmb       — Google Business Profile listing (attribution is fuzzy)
--   manual    — anything else / "Other"
--
-- Free-form text (no CHECK constraint) so new sources can be added
-- without another migration — matches migration 003's approach.

alter table entries
  add column if not exists lead_source text;

-- Partial index — only enquiry rows will ever populate this column, so
-- there's no benefit to indexing the (mostly null) rest of the table.
create index if not exists entries_lead_source_idx
  on entries (lead_source)
  where lead_source is not null;
