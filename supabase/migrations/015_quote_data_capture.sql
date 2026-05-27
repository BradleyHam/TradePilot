-- =============================================================
-- Migration 015 — Richer quote-data capture on jobs
-- =============================================================
-- Adds the structured fields the wrap-up sheet collects to feed
-- Tier-2's quote-drafting AI. Every field is nullable — capture
-- whatever Brad has time for at the site visit; the AI works with
-- partial info.
--
-- Why these fields specifically:
--   coats_count            — 1/2/3, biggest line-item-cost lever after area
--   stain_product          — Wood-X vs Cedarshield vs Resene Woodsman etc.
--                            Drives materials cost AND coat-count defaults.
--   window_door_count      — quick count → cutting-in time estimate
--   addon_items            — soffits/decking/handrails/etc. The "easy to
--                            forget to scope, easy to lose money on" stuff.
--   site_logistics         — parking/water/power/pets — affects setup time
--                            and tool selection. Multi-value chips.
--   days_estimate          — Brad's gut feel after walking the site. The
--                            AI compares this against the area/prep math
--                            and flags if they disagree (a useful sanity
--                            check both ways).
--   commercial_signals     — referral / urgent / price-shopping / repeat
--                            customer. The soft factors that move quote
--                            prices ±15% without changing the cost basis.
--                            Stored as text[] so the chip vocabulary can
--                            evolve without a migration.

alter table jobs
  add column if not exists coats_count          smallint,
  add column if not exists stain_product        text,
  add column if not exists window_door_count    smallint,
  add column if not exists addon_items          text[],
  add column if not exists site_logistics       text[],
  add column if not exists days_estimate        numeric(5,1),
  add column if not exists commercial_signals   text[];

-- Loose CHECK on coats_count — we expect 1/2/3 in practice but allow
-- up to 5 for unusual multi-coat builds (clear coat over stain etc).
-- Anything over 5 is almost certainly a data-entry mistake.
alter table jobs
  add constraint jobs_coats_count_sane
  check (coats_count is null or (coats_count between 1 and 5));

-- Same defensive bound on window count — a single job with >200
-- windows/doors is bigger than a typical Brad job.
alter table jobs
  add constraint jobs_window_door_count_sane
  check (window_door_count is null or (window_door_count between 0 and 200));
