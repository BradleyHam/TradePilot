-- =============================================================
-- Migration 036 — job cover photo
-- =============================================================
-- A "main image" per job so staff can recognise a job by sight in the
-- Log Hours picker and their calendar, instead of parsing similar names
-- ("Cedar Restoration…" vs "Exterior Repaint & Cedar Maintenance…").
--
-- ## Why the path points at the shift-photos bucket
--
-- The obvious source images live in `quote-attachments`, but that bucket
-- is OWNER-ONLY and holds quote/invoice PDFs with pricing on them.
-- Opening it to employees would blow a hole in money-blindness. The
-- `shift-photos` bucket (migration 027) already grants read to any MEMBER
-- of the business and contains nothing financial — so the app COPIES the
-- chosen image into shift-photos and stores that path here. Employees can
-- therefore sign a URL for the cover and nothing else.
--
-- Path convention: {businessId}/{jobId}/cover__{uuid}__{filename}
-- (same bucket layout as shift photos, so the existing storage policies
-- apply unchanged — no new storage policy needed.)

alter table jobs
  add column if not exists cover_photo_path text;

comment on column jobs.cover_photo_path is
  'Object path in the shift-photos bucket used as the job''s main image. Never a URL — signed on demand. Nullable: when null the app falls back to the newest photo on the job.';

-- ── jobs_public: expose the cover to employees ──────────────────────────
-- Identical to migration 035's definition plus cover_photo_path. Still
-- money-free; still assignment-scoped.
drop view if exists public.jobs_public;
create view public.jobs_public as
  select
    id, business_id, legacy_id, name,
    client_name, client_email, client_phone, location,
    status, start_date, end_date, follow_up_date, lead_date,
    notes, cover_photo_path, created_at, updated_at
  from public.jobs
  where business_id in (select public.current_user_business_ids())
    and (
      business_id in (select id from businesses where owner_id = auth.uid())
      or public.user_assigned_to_job(id)
    );

grant select on public.jobs_public to authenticated;
