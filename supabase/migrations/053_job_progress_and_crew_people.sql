-- =============================================================
-- Migration 053 — planning crew + dated job progress
-- =============================================================
-- `crew_people` is a reusable NO-LOGIN directory. It is intentionally not
-- `business_members`: saving a painter for forecasting must not create app
-- access, payroll periods, PAYE reminders, or schedule visibility.
--
-- Progress is append-only. A later estimate creates a later snapshot rather
-- than overwriting the earlier month, so September work cannot quietly rewrite
-- August's management report. These figures are owner-only management data;
-- they never create income entries or feed GST, PAYE, or tax calculations.

create table if not exists crew_people (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id) on delete cascade not null,
  display_name text not null check (char_length(trim(display_name)) between 1 and 120),
  worker_kind  text not null check (worker_kind in ('experienced', 'apprentice', 'helper', 'subcontractor')),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists crew_people_business_idx
  on crew_people(business_id, archived_at, display_name);
create unique index if not exists crew_people_active_name_idx
  on crew_people(business_id, lower(trim(display_name)))
  where archived_at is null;

drop trigger if exists crew_people_updated_at on crew_people;
create trigger crew_people_updated_at
  before update on crew_people
  for each row execute function update_updated_at();

alter table crew_people enable row level security;

drop policy if exists "owner manages planning crew" on crew_people;
create policy "owner manages planning crew"
  on crew_people for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

-- Keep table-level powers narrow too: RLS does not protect TRUNCATE.
revoke all on crew_people from anon, authenticated;
grant select, insert, update, delete on crew_people to authenticated;

create table if not exists job_progress_snapshots (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid references businesses(id) on delete cascade not null,
  job_id                   uuid references jobs(id) on delete cascade not null,
  as_of_date               date not null,
  state                    text not null check (state in ('forecast', 'complete')),
  actual_person_hours      numeric(9,2) not null check (actual_person_hours >= 0),
  legacy_helper_hours      numeric(9,2) not null default 0 check (legacy_helper_hours >= 0),
  remaining_person_hours   numeric(9,2) not null check (remaining_person_hours >= 0),
  forecast_person_hours    numeric(9,2) not null check (forecast_person_hours >= 0),
  job_value_ex_gst         numeric(12,2) not null check (job_value_ex_gst >= 0),
  value_source             text not null check (value_source in ('invoice', 'quote', 'estimate', 'none')),
  progress_fraction        numeric(8,7) not null check (progress_fraction between 0 and 1),
  earned_to_date_ex_gst    numeric(12,2) not null check (earned_to_date_ex_gst >= 0),
  note                     text,
  recorded_by              uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  check (abs(forecast_person_hours - actual_person_hours - remaining_person_hours) <= 0.01),
  check (state <> 'complete' or (remaining_person_hours = 0 and progress_fraction = 1))
);

create index if not exists job_progress_snapshots_lookup_idx
  on job_progress_snapshots(business_id, job_id, as_of_date desc, created_at desc);

alter table job_progress_snapshots enable row level security;

drop policy if exists "owner manages job progress" on job_progress_snapshots;
drop policy if exists "owner reads job progress" on job_progress_snapshots;
create policy "owner reads job progress"
  on job_progress_snapshots for select
  using (business_id in (select id from businesses where owner_id = auth.uid()));

create table if not exists job_progress_people (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid references businesses(id) on delete cascade not null,
  snapshot_id          uuid references job_progress_snapshots(id) on delete cascade not null,
  business_member_id   uuid references business_members(id) on delete set null,
  crew_person_id       uuid references crew_people(id) on delete set null,
  person_name          text not null check (char_length(trim(person_name)) between 1 and 120),
  worker_kind          text not null check (worker_kind in ('owner', 'experienced', 'apprentice', 'helper', 'subcontractor')),
  remaining_hours      numeric(8,2) not null check (remaining_hours > 0),
  input_days           numeric(6,2) check (input_days is null or input_days > 0),
  hours_per_day        numeric(5,2) check (hours_per_day is null or hours_per_day > 0),
  created_at           timestamptz not null default now(),
  check (num_nonnulls(business_member_id, crew_person_id) <= 1)
);

create index if not exists job_progress_people_snapshot_idx
  on job_progress_people(snapshot_id, created_at);

alter table job_progress_people enable row level security;

drop policy if exists "owner manages job progress people" on job_progress_people;
drop policy if exists "owner reads job progress people" on job_progress_people;
create policy "owner reads job progress people"
  on job_progress_people for select
  using (business_id in (select id from businesses where owner_id = auth.uid()));

-- Authenticated clients may read their owner-scoped history, but cannot
-- insert, rewrite or delete it directly. The checked RPC below is the only
-- write path, which makes the progress ledger append-only in the app.
revoke all on job_progress_snapshots from anon, authenticated;
revoke all on job_progress_people from anon, authenticated;
grant select on job_progress_snapshots to authenticated;
grant select on job_progress_people to authenticated;

-- Insert the progress header and its named people together. The database
-- calculates actual person-hours and snapshots the job value so the client
-- cannot save a stale or half-complete progress record.
create or replace function record_job_progress(
  p_job_id uuid,
  p_as_of_date date,
  p_state text,
  p_people jsonb default '[]'::jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job jobs%rowtype;
  v_snapshot job_progress_snapshots%rowtype;
  v_person jsonb;
  v_business_member_id uuid;
  v_crew_person_id uuid;
  v_name text;
  v_worker_kind text;
  v_person_remaining numeric;
  v_input_days numeric;
  v_hours_per_day numeric;
  v_direct_hours numeric := 0;
  v_legacy_hours numeric := 0;
  v_actual numeric := 0;
  v_remaining numeric := 0;
  v_forecast numeric := 0;
  v_job_value numeric := 0;
  v_value_source text := 'none';
  v_progress numeric := 0;
  v_earned numeric := 0;
begin
  if p_as_of_date is null then
    raise exception 'Progress date is required';
  end if;
  if p_as_of_date > (now() at time zone 'Pacific/Auckland')::date then
    raise exception 'Progress date cannot be in the future';
  end if;
  if p_state not in ('forecast', 'complete') then
    raise exception 'Progress state must be forecast or complete';
  end if;
  if jsonb_typeof(coalesce(p_people, '[]'::jsonb)) <> 'array' then
    raise exception 'Progress people must be an array';
  end if;

  select j.* into v_job
  from jobs j
  where j.id = p_job_id
    and j.business_id in (select id from businesses where owner_id = auth.uid())
  for update;

  if not found then
    raise exception 'Job not found or not owned by the signed-in user';
  end if;

  select
    coalesce(sum(coalesce(e.hours, 0)), 0),
    coalesce(sum(coalesce(e.helper_hours, 0)), 0)
  into v_direct_hours, v_legacy_hours
  from entries e
  where e.business_id = v_job.business_id
    and e.job_id = v_job.id
    and e.type = 'hours'
    and e.entry_date <= p_as_of_date
    and not coalesce(e.is_draft, false);

  v_actual := round((v_direct_hours + v_legacy_hours)::numeric, 2);

  if coalesce(v_job.invoice_amount, 0) > 0 then
    v_job_value := v_job.invoice_amount;
    v_value_source := 'invoice';
  elsif coalesce(v_job.quote_amount, 0) > 0 then
    v_job_value := v_job.quote_amount;
    v_value_source := 'quote';
  elsif coalesce(v_job.estimated_value, 0) > 0 then
    v_job_value := v_job.estimated_value;
    v_value_source := 'estimate';
  end if;

  if p_state = 'forecast' then
    for v_person in select value from jsonb_array_elements(coalesce(p_people, '[]'::jsonb))
    loop
      v_name := trim(coalesce(v_person->>'person_name', ''));
      v_worker_kind := coalesce(v_person->>'worker_kind', '');
      v_person_remaining := coalesce((v_person->>'remaining_hours')::numeric, 0);
      v_business_member_id := nullif(v_person->>'business_member_id', '')::uuid;
      v_crew_person_id := nullif(v_person->>'crew_person_id', '')::uuid;

      if v_name = '' then raise exception 'Every selected person needs a name'; end if;
      if v_worker_kind not in ('owner', 'experienced', 'apprentice', 'helper', 'subcontractor') then
        raise exception 'Unknown worker category for %', v_name;
      end if;
      if v_person_remaining <= 0 then raise exception 'Remaining hours must be above zero for %', v_name; end if;
      if v_business_member_id is not null and v_crew_person_id is not null then
        raise exception 'A progress person cannot reference two directories';
      end if;
      if v_business_member_id is not null and not exists (
        select 1 from business_members
        where id = v_business_member_id and business_id = v_job.business_id
      ) then raise exception 'Team member does not belong to this business'; end if;
      if v_crew_person_id is not null and not exists (
        select 1 from crew_people
        where id = v_crew_person_id and business_id = v_job.business_id and archived_at is null
      ) then raise exception 'Planning person does not belong to this business'; end if;

      v_remaining := v_remaining + v_person_remaining;
    end loop;

    if v_remaining <= 0 then
      raise exception 'Select at least one person and add some work left';
    end if;
  end if;

  v_remaining := round(v_remaining::numeric, 2);
  v_forecast := round((v_actual + v_remaining)::numeric, 2);
  if p_state = 'complete' then
    v_remaining := 0;
    v_forecast := v_actual;
    v_progress := 1;
  elsif v_forecast > 0 then
    v_progress := least(1, round((v_actual / v_forecast)::numeric, 7));
  end if;
  v_earned := round((v_job_value * v_progress)::numeric, 2);

  insert into job_progress_snapshots (
    business_id, job_id, as_of_date, state,
    actual_person_hours, legacy_helper_hours, remaining_person_hours, forecast_person_hours,
    job_value_ex_gst, value_source, progress_fraction, earned_to_date_ex_gst,
    note, recorded_by
  ) values (
    v_job.business_id, v_job.id, p_as_of_date, p_state,
    v_actual, v_legacy_hours, v_remaining, v_forecast,
    v_job_value, v_value_source, v_progress, v_earned,
    nullif(trim(coalesce(p_note, '')), ''), auth.uid()
  ) returning * into v_snapshot;

  if p_state = 'forecast' then
    for v_person in select value from jsonb_array_elements(coalesce(p_people, '[]'::jsonb))
    loop
      v_business_member_id := nullif(v_person->>'business_member_id', '')::uuid;
      v_crew_person_id := nullif(v_person->>'crew_person_id', '')::uuid;
      v_input_days := nullif(v_person->>'input_days', '')::numeric;
      v_hours_per_day := nullif(v_person->>'hours_per_day', '')::numeric;
      insert into job_progress_people (
        business_id, snapshot_id, business_member_id, crew_person_id,
        person_name, worker_kind, remaining_hours, input_days, hours_per_day
      ) values (
        v_job.business_id, v_snapshot.id, v_business_member_id, v_crew_person_id,
        trim(v_person->>'person_name'), v_person->>'worker_kind',
        (v_person->>'remaining_hours')::numeric, v_input_days, v_hours_per_day
      );
    end loop;
  end if;

  return jsonb_build_object(
    'snapshot', to_jsonb(v_snapshot),
    'people', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at, p.id)
      from job_progress_people p where p.snapshot_id = v_snapshot.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function record_job_progress(uuid, date, text, jsonb, text) from public;
revoke all on function record_job_progress(uuid, date, text, jsonb, text) from anon;
grant execute on function record_job_progress(uuid, date, text, jsonb, text) to authenticated;
