-- =============================================================
-- Migration 022 — allow 'process_photo' kind on quote_attachments
-- =============================================================
-- The Marketing tab can now attach work-in-progress ("Progress") photos,
-- which the painters-wanaka site renders in its Process gallery. Extend the
-- kind CHECK constraint to permit 'process_photo'.
--
-- Additive + safe: existing rows are unaffected; this only widens the allowed
-- set. The DO block drops the existing kind check constraint by whatever name
-- Postgres gave it (inline column checks are auto-named), then re-adds it.

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
    'quote_pdf',
    'other'
  ));
