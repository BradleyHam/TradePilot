-- Backfill the Luke Campbell / Condon Scott "Timber Weatherboard Restoration"
-- enquiry (received 8 Jul 2026) as an email lead.
--
-- Text-only: photos + the plan PDF live in Storage and can't be inserted via
-- SQL — either drop them into the job's "Plans + photos" panel in the app, or
-- run scripts/backfill-luke-lead.ts to upload them.
--
-- Idempotent: does nothing if a lead with this client_email already exists.
-- Assumes a single business row (the Lakeside sandbox). If you ever have more
-- than one, replace the two subqueries with your explicit TRADEPILOT_BUSINESS_ID.

insert into jobs (
  business_id, name, client_name, client_email, client_phone,
  location, status, source, notes
)
select
  (select id from businesses order by created_at limit 1),
  'Timber weatherboard restoration — Wānaka',
  'Luke Campbell (Condon Scott)',
  'luke@condonscott.nz',
  '+64 3 443 7919',
  'Wānaka (site address TBC)',
  'lead',
  'email',
  E'Email enquiry (forwarded from info@lakesidepainting.co.nz), received 8 Jul 2026.\n\n'
  'Renovation project in Wānaka restoring existing timber weatherboards. Boards show black staining and weathering; some sections previously re-stained grey. Client asked for a recommended restoration approach + ballpark cost. Their own thinking: prep then a darker penetrating stain for a more consistent finish. Plans attached show which exterior walls are being retained.\n\n'
  'Lead contact: Luke Campbell — Architectural Designer, Condon Scott (luke@condonscott.nz, +64 3 443 7919). CC: jordan@condonscott.nz, james@condonscott.nz.\n'
  'Note: confirm the actual site address — 37 McDougall St is the Condon Scott office, not the job.\n\n'
  'Already replied 8 Jul with a $6,500–$9,500 + GST ballpark, pending a site visit.'
where not exists (
  select 1 from jobs
  where client_email = 'luke@condonscott.nz'
    and business_id = (select id from businesses order by created_at limit 1)
);
