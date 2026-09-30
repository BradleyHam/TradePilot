-- An explicit quoting budget, separate from work-left / earned-income snapshots.
-- Existing jobs remain unestimated; never backfill guesses from days or crew size.
begin;

alter table public.jobs
  add column if not exists hours_estimate jsonb;

create or replace function public.valid_job_hours_estimate(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare role text; hours jsonb; total numeric; role_total numeric := 0;
begin
  if value is null then return true; end if;
  if jsonb_typeof(value) <> 'object' or jsonb_typeof(value->'total') is distinct from 'number' then return false; end if;
  total := (value->>'total')::numeric;
  if total <= 0 or total > 100000 then return false; end if;
  if value ? 'byRole' then
    if jsonb_typeof(value->'byRole') <> 'object' then return false; end if;
    for role, hours in select * from jsonb_each(value->'byRole') loop
      if role not in ('experienced', 'helper', 'apprentice', 'subcontractor') or jsonb_typeof(hours) <> 'number' then return false; end if;
      if hours::numeric < 0 then return false; end if;
      role_total := role_total + hours::numeric;
    end loop;
    if abs(role_total - total) > 0.001 then return false; end if;
  end if;
  return true;
end;
$$;

alter table public.jobs drop constraint if exists jobs_hours_estimate_valid;
alter table public.jobs add constraint jobs_hours_estimate_valid
  check (public.valid_job_hours_estimate(hours_estimate));

comment on column public.jobs.hours_estimate is
  'Original person-hours budget: total and optional byRole. Owner hours compare as experienced. Progress updates never change this budget.';

commit;
