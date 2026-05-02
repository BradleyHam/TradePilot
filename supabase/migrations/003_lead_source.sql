-- =============================================================
-- Migration 003 — Lead source on jobs
-- =============================================================
-- Distinguishes website-auto leads (from the painterswanaka.co.nz
-- contact form webhook) from manually-entered jobs. Nullable; existing
-- rows stay null and are treated as 'manual' in the UI.
--
-- Values:
--   website   — POSTed in by the website webhook
--   email     — email parser / forwarded enquiry (future)
--   phone     — manual lead from a phone call
--   referral  — word of mouth
--   manual    — anything else logged by hand
--
-- Kept as a free-form text column (not a CHECK constraint) so we can
-- evolve sources without another migration. UI normalises display.

alter table jobs
  add column if not exists source text;

create index if not exists jobs_source_idx on jobs(source);
