-- =============================================================
-- Migration 052 — reusable client job links
-- =============================================================
-- One private link per job gives the client a deliberately narrow view of
-- their job: agreed scope/price, dates, issued invoices, approved photos and
-- open variations. The link is a bearer secret, can be disabled instantly,
-- and never grants direct browser access to the underlying tables.

alter table shift_photos
  add column if not exists client_visible boolean not null default false;

create table if not exists job_client_links (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid references businesses(id) on delete cascade not null,
  job_id              uuid references jobs(id) on delete cascade not null unique,
  access_token        uuid not null default gen_random_uuid() unique,
  enabled             boolean not null default true,
  last_viewed_at      timestamptz,
  view_count          integer not null default 0 check (view_count >= 0),
  quote_accepted_at   timestamptz,
  quote_accepted_by   text,
  last_activity_at    timestamptz,
  last_activity_kind  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists job_client_links_business_idx
  on job_client_links(business_id, updated_at desc);

drop trigger if exists job_client_links_updated_at on job_client_links;
create trigger job_client_links_updated_at
  before update on job_client_links
  for each row execute function update_updated_at();

alter table job_client_links enable row level security;

-- The signed-in app is owner-only. Public pages use the server service role
-- and return only a hand-picked client-safe projection.
drop policy if exists "owner manages client job links" on job_client_links;
create policy "owner manages client job links"
  on job_client_links for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

-- Record that the private link was opened. Refreshes count as opens: the
-- owner-side UI calls this "opened", not "unique client views", so it never
-- overclaims what the signal proves.
create or replace function record_client_job_link_view(p_token uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link job_client_links%rowtype;
begin
  select * into v_link
  from job_client_links
  where access_token = p_token
    and enabled = true
  for update;

  if not found then
    raise exception 'Client job link not found';
  end if;

  update job_client_links
  set last_viewed_at = now(),
      view_count = view_count + 1,
      last_activity_at = now(),
      last_activity_kind = 'viewed'
  where id = v_link.id
  returning * into v_link;

  return to_jsonb(v_link);
end;
$$;

-- Accept the current quote exactly once. The job, newest quote record,
-- contact history and client-link audit stamp move together in one database
-- transaction, so a refresh or double tap cannot create a half-accepted job.
create or replace function respond_to_client_quote(
  p_token uuid,
  p_accepted_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link job_client_links%rowtype;
  v_job jobs%rowtype;
  v_name text;
begin
  v_name := trim(coalesce(p_accepted_by, ''));
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Client name is required';
  end if;

  select * into v_link
  from job_client_links
  where access_token = p_token
    and enabled = true
  for update;

  if not found then
    raise exception 'Client job link not found';
  end if;

  select * into v_job
  from jobs
  where id = v_link.job_id
  for update;

  if not found then
    raise exception 'Job not found';
  end if;

  -- The link carries the authoritative portal acceptance stamp. Once it is
  -- set, every retry returns the same outcome without touching any totals or
  -- history. A job accepted elsewhere is also treated as already settled.
  if v_link.quote_accepted_at is not null
     or v_job.status in ('accepted', 'booked', 'in-progress', 'completed', 'invoiced', 'paid') then
    return jsonb_build_object(
      'link', to_jsonb(v_link),
      'job', to_jsonb(v_job),
      'already_responded', true
    );
  end if;

  if v_job.status <> 'quoted' then
    raise exception 'Quote is not open for acceptance';
  end if;

  if coalesce(v_job.quote_amount, 0) <= 0 then
    raise exception 'Quote has no agreed price';
  end if;

  update jobs
  set status = 'accepted',
      accepted_at = coalesce(accepted_at, now()),
      last_contacted_date = now()
  where id = v_job.id
  returning * into v_job;

  -- Keep the first-class quote row in step when one exists. The job can also
  -- carry a legitimate handshake price with no quote row, so zero rows is OK.
  update quotes
  set status = 'accepted',
      won_amount_ex_gst = coalesce(won_amount_ex_gst, v_job.quote_amount),
      outcome_date = coalesce(outcome_date, current_date)
  where id = (
    select q.id
    from quotes q
    where q.job_id = v_job.id
      and q.status in ('draft', 'sent')
    order by q.date_sent desc nulls last, q.created_at desc
    limit 1
  );

  insert into job_contacts (
    business_id, job_id, contacted_at, direction, channel, note
  ) values (
    v_job.business_id, v_job.id, now(), 'in', 'other',
    'Quote approved through the client job link by ' || v_name || '.'
  );

  update job_client_links
  set quote_accepted_at = now(),
      quote_accepted_by = v_name,
      last_activity_at = now(),
      last_activity_kind = 'quote-approved'
  where id = v_link.id
  returning * into v_link;

  return jsonb_build_object(
    'link', to_jsonb(v_link),
    'job', to_jsonb(v_job),
    'already_responded', false
  );
end;
$$;

-- Possessing a token never gives the browser table/RPC privileges. Only the
-- server-side route may record views or settle a quote.
revoke all on function record_client_job_link_view(uuid) from public;
revoke all on function record_client_job_link_view(uuid) from anon;
revoke all on function record_client_job_link_view(uuid) from authenticated;
grant execute on function record_client_job_link_view(uuid) to service_role;

revoke all on function respond_to_client_quote(uuid, text) from public;
revoke all on function respond_to_client_quote(uuid, text) from anon;
revoke all on function respond_to_client_quote(uuid, text) from authenticated;
grant execute on function respond_to_client_quote(uuid, text) to service_role;
