-- =============================================================
-- Migration 037 — cover source + on-site scope for staff
-- =============================================================
-- Two additions, both employee-visible via jobs_public:
--
-- 1. `cover_photo_source` — the ORIGINAL path a cover was pinned from.
--    Covers pinned from `quote-attachments` (owner-only, holds priced
--    PDFs) get COPIED into `shift-photos` so employees can read them,
--    which means the stored cover path bears no resemblance to the
--    source. This column lets the UI star the right thumbnail.
--
-- 2. `scope_included` / `scope_excluded` — plain-language "what this job
--    covers / what it doesn't", so whoever is on site knows where the
--    job stops without being able to see the quote itself. Usually
--    extracted from the quote PDF by /api/parse-scope, always reviewed
--    by the owner before saving.
--
--    ⚠ These are EMPLOYEE-VISIBLE. The extractor is instructed to strip
--    prices and the owner reviews before save, but treat them like job
--    notes: no pricing.

alter table jobs
  add column if not exists cover_photo_source text,
  add column if not exists scope_included text[],
  add column if not exists scope_excluded text[];

comment on column jobs.cover_photo_source is
  'Original object path the cover photo was pinned from (may be in a bucket employees cannot read). UI-only, so the correct source thumbnail can be starred.';
comment on column jobs.scope_included is
  'Plain-language inclusions shown to on-site staff. EMPLOYEE-VISIBLE — never put pricing here.';
comment on column jobs.scope_excluded is
  'Plain-language exclusions shown to on-site staff. EMPLOYEE-VISIBLE — never put pricing here.';

-- ── jobs_public: money-free, assignment-scoped, now with scope ──────────
-- cover_photo_source is deliberately NOT exposed: employees can't read
-- the source bucket anyway, and it's only needed by the owner's UI.
drop view if exists public.jobs_public;
create view public.jobs_public as
  select
    id, business_id, legacy_id, name,
    client_name, client_email, client_phone, location,
    status, start_date, end_date, follow_up_date, lead_date,
    notes, cover_photo_path, scope_included, scope_excluded,
    created_at, updated_at
  from public.jobs
  where business_id in (select public.current_user_business_ids())
    and (
      business_id in (select id from businesses where owner_id = auth.uid())
      or public.user_assigned_to_job(id)
    );

grant select on public.jobs_public to authenticated;
