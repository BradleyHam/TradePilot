-- =============================================================
-- Migration 017 — business-logos Storage bucket
-- =============================================================
-- Storage for each business's logo. Public read because quote PDFs
-- need to embed the logo via signed URL — and we don't want the
-- signed URL to expire mid-render. RLS on writes so a business can
-- only upload to its own folder.
--
-- Object path convention: {businessId}/logo.{ext}
--   - One logo per business; uploading replaces the previous one.
--   - We keep the extension so the bucket stores PNG / JPG / SVG
--     correctly and the PDF generator can pick the right MIME type.
--
-- This is a Supabase Storage migration so a lot of it goes through
-- the storage.* schema rather than the public schema.

-- Idempotent bucket creation. `public = true` makes objects in
-- this bucket readable without a signed URL — fine for logos that
-- get embedded in customer-facing quote PDFs anyway.
insert into storage.buckets (id, name, public)
values ('business-logos', 'business-logos', true)
on conflict (id) do nothing;

-- ── Policies ─────────────────────────────────────────────────────
-- Public read: anyone can GET an object. We want this so the
-- generated quote PDFs can embed the logo without juggling signed
-- URLs. The folder structure (one per business) limits surface.
drop policy if exists "Public can read business logos"
  on storage.objects;
create policy "Public can read business logos"
  on storage.objects for select using (
    bucket_id = 'business-logos'
  );

-- Owner write: the authenticated user can only upload to their
-- own business's folder. The first path segment must match a
-- business they own (split_part picks the {businessId} prefix
-- from object names like '{businessId}/logo.png').
drop policy if exists "Owners can upload business logos"
  on storage.objects;
create policy "Owners can upload business logos"
  on storage.objects for insert with check (
    bucket_id = 'business-logos'
    and (split_part(name, '/', 1))::uuid in (
      select id from businesses where owner_id = auth.uid()
    )
  );

drop policy if exists "Owners can update business logos"
  on storage.objects;
create policy "Owners can update business logos"
  on storage.objects for update using (
    bucket_id = 'business-logos'
    and (split_part(name, '/', 1))::uuid in (
      select id from businesses where owner_id = auth.uid()
    )
  );

drop policy if exists "Owners can delete business logos"
  on storage.objects;
create policy "Owners can delete business logos"
  on storage.objects for delete using (
    bucket_id = 'business-logos'
    and (split_part(name, '/', 1))::uuid in (
      select id from businesses where owner_id = auth.uid()
    )
  );
