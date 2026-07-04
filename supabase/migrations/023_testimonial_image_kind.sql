-- =============================================================
-- Migration 023 — allow 'testimonial_image' kind on quote_attachments
-- =============================================================
-- The Facebook composer can now generate a branded testimonial card
-- (client review rendered as a 1080×1080 image) and attach it to the job
-- so it can lead the Facebook/Instagram post. Extend the kind CHECK
-- constraint to permit 'testimonial_image'.
--
-- Additive + safe: existing rows are unaffected; this only widens the
-- allowed set. Same DO-block pattern as migration 022 (drop the
-- auto-named check constraint, re-add with the wider list).

do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'quote_attachments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%before_photo%';
  if c is not null then
    execute format('alter table quote_attachments drop constraint %I', c);
  end if;
end $$;

alter table quote_attachments add constraint quote_attachments_kind_check
  check (kind in (
    'plan',
    'before_photo',
    'after_photo',
    'scope_photo',
    'process_photo',
    'testimonial_image',
    'quote_pdf',
    'other'
  ));
