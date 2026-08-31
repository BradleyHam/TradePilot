-- =============================================================
-- Migration 051 — Variation Guard
-- =============================================================
-- Extra work is reviewed by Brad, priced ex-GST, and shared through an
-- unguessable client approval link. Approval is atomic: the variation can
-- only move once, and the job's agreed/invoice totals rise in the same DB
-- transaction. Repeated taps or webhook retries can never add it twice.

create table if not exists job_variations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade not null,
  job_id          uuid references jobs(id) on delete cascade not null,
  shift_report_id uuid references shift_reports(id) on delete set null,
  title           text not null,
  description     text,
  amount_ex_gst   numeric(12,2) not null check (amount_ex_gst > 0),
  status          text not null default 'draft'
                  check (status in ('draft', 'ready', 'approved', 'declined', 'cancelled')),
  approval_token  uuid not null default gen_random_uuid() unique,
  photo_ids       uuid[] not null default '{}',
  responded_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists job_variations_business_job_idx
  on job_variations(business_id, job_id, created_at desc);
create unique index if not exists job_variations_shift_report_idx
  on job_variations(shift_report_id)
  where shift_report_id is not null;

drop trigger if exists job_variations_updated_at on job_variations;
create trigger job_variations_updated_at
  before update on job_variations
  for each row execute function update_updated_at();

alter table job_variations enable row level security;

-- Prices and client responses stay owner-only inside the signed-in app.
-- The public page never queries this table as anon; its narrow server route
-- uses the service role and exposes only the selected variation.
drop policy if exists "owner manages job variations" on job_variations;
create policy "owner manages job variations"
  on job_variations for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

create or replace function respond_to_job_variation(
  p_token uuid,
  p_response text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_variation job_variations%rowtype;
  v_job jobs%rowtype;
begin
  if p_response not in ('approved', 'declined') then
    raise exception 'Invalid variation response';
  end if;

  select * into v_variation
  from job_variations
  where approval_token = p_token
  for update;

  if not found then
    raise exception 'Variation not found';
  end if;

  -- Idempotent response: refreshes/retries return the settled result and do
  -- not touch the job totals again.
  if v_variation.status in ('approved', 'declined') then
    select * into v_job from jobs where id = v_variation.job_id;
    return jsonb_build_object(
      'variation', to_jsonb(v_variation),
      'job', to_jsonb(v_job),
      'already_responded', true
    );
  end if;

  if v_variation.status <> 'ready' then
    raise exception 'Variation is not open for approval';
  end if;

  select * into v_job
  from jobs
  where id = v_variation.job_id
  for update;

  if not found then
    raise exception 'Job not found';
  end if;

  if p_response = 'approved' then
    -- A variation must add to a real agreed total. invoice_amount mirrors
    -- the job total once an invoice/deposit exists, so raise it too when
    -- present; otherwise InvoiceAction would suggest the old final balance.
    if v_job.quote_amount is null and v_job.invoice_amount is null then
      raise exception 'Job has no agreed price';
    end if;

    update jobs
    set quote_amount = round((coalesce(quote_amount, invoice_amount, 0) + v_variation.amount_ex_gst)::numeric, 2),
        invoice_amount = case
          when invoice_amount is null then null
          else round((invoice_amount + v_variation.amount_ex_gst)::numeric, 2)
        end
    where id = v_job.id
    returning * into v_job;
  end if;

  update job_variations
  set status = p_response,
      responded_at = now()
  where id = v_variation.id
  returning * into v_variation;

  return jsonb_build_object(
    'variation', to_jsonb(v_variation),
    'job', to_jsonb(v_job),
    'already_responded', false
  );
end;
$$;

-- Only the server-side service client may settle a public approval. The
-- browser receives no direct table/RPC permission from possessing a token.
revoke all on function respond_to_job_variation(uuid, text) from public;
revoke all on function respond_to_job_variation(uuid, text) from anon;
revoke all on function respond_to_job_variation(uuid, text) from authenticated;
grant execute on function respond_to_job_variation(uuid, text) to service_role;
