-- =============================================================
-- Migration 014 — Site-visit wrap-up + quote template foundation
-- =============================================================
-- Captures the structured scope-of-work data the moment Brad walks
-- back to the van, BEFORE the mental notes evaporate. Drives the
-- "Site Visit Wrap-Up" sheet that opens when a quote_visit row is
-- ticked on Home / Schedule.
--
-- Three small additions to `jobs`:
--   scope_notes      — free-form text capture (rambled scope as typed)
--   access_notes     — array of chip values (ladder, scaffold, etc)
--   quote_ready_by   — date Brad promised the customer the quote
--
-- One seeded row in `settings`:
--   quote_template   — JSON blob storing the per-business quote shape
--                      (header, T&Cs, payment schedule, validity).
--                      Tier 2 (the Claude-assisted quote builder) will
--                      read this. No UI to edit yet — seeded with Brad's
--                      Lakeside defaults.
--
-- All new columns are nullable. Existing job rows aren't touched.

alter table jobs
  add column if not exists scope_notes    text,
  add column if not exists access_notes   text[],
  add column if not exists quote_ready_by date;

-- Partial index — only open quote-stage jobs ever sort or filter by
-- quote_ready_by (the "do I owe someone a quote?" question). Saves
-- index cost on the thousands of completed/paid rows.
create index if not exists jobs_quote_ready_by_idx
  on jobs (quote_ready_by)
  where status in ('lead', 'quoted');

-- ── Quote template ──────────────────────────────────────────────────────
-- Seeded as a settings row for every existing business. The template
-- shape is deliberately a single JSON blob (vs. a dedicated table with
-- columns) because:
--   1. The template content is small — fits in one row comfortably.
--   2. The shape will evolve as we build the quote editor; JSON gives
--      us schema flexibility without ALTER TABLE migrations every time.
--   3. There's only ever ONE template per business — no need for joins.
--
-- The seeded values are Lakeside Painting's actuals (Brad's standard
-- T&Cs, 30% deposit terms, 30-day validity). Future businesses get
-- the same defaults until we build a Settings UI to edit them.
insert into settings (business_id, key, value, notes)
select
  b.id,
  'quote_template',
  json_build_object(
    'header', json_build_object(
      'businessName', 'Lakeside Painting Ltd',
      'gstNumber', null,                            -- to be filled by Settings UI
      'phone', null,
      'email', null,
      'address', 'Wanaka, NZ'
    ),
    'paymentTerms', json_build_object(
      'depositPercent', 30,
      'depositDueDays', 7,                          -- after quote acceptance
      'balanceDue', 'on_completion'                 -- vs. progress-billed
    ),
    'validityDays', 30,
    'gstTreatment', 'incl',                         -- quotes shown incl-GST per NZ convention
    'defaultTerms', E'• Quote valid for 30 days from date issued.\n'
                 || E'• 30% deposit required to confirm booking.\n'
                 || E'• Balance payable on completion.\n'
                 || E'• Two coats applied to all surfaces unless specified otherwise.\n'
                 || E'• Customer to provide reasonable site access and clear work areas.\n'
                 || E'• Quote excludes any repair or remedial work not visible at site visit.\n'
                 || E'• Weather delays may affect agreed start dates.'
  )::text,
  'Default quote template — edit via Settings (UI pending).'
from businesses b
where not exists (
  select 1 from settings s
  where s.business_id = b.id and s.key = 'quote_template'
);
