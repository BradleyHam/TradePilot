-- =============================================================
-- Trade Pilot seed
-- =============================================================
-- Run this AFTER schema.sql AND after you've created your user
-- in the Supabase dashboard (Auth → Users → Add user → bradleyjamesham@gmail.com).
--
-- This creates one business owned by that user and seeds GST settings.
-- It's idempotent: re-running won't create duplicates.
--
-- Real Lakeside Painting data is loaded by the importer:
--   pnpm tsx scripts/import-finances.ts
-- (We've left the original demo seed in supabase/seed.demo.sql for reference.)

do $$
declare
  v_user_id uuid;
  v_biz_id  uuid;
begin
  -- Find the owner by email. Adjust if you used a different email.
  select id into v_user_id
  from auth.users
  where email = 'bradleyjamesham@gmail.com'
  limit 1;

  if v_user_id is null then
    raise exception 'No auth user found for bradleyjamesham@gmail.com. Create the user in Auth → Users → Add user first.';
  end if;

  -- Create the Lakeside Painting business if it doesn't exist yet.
  select id into v_biz_id
  from businesses
  where owner_id = v_user_id and name = 'Lakeside Painting'
  limit 1;

  if v_biz_id is null then
    insert into businesses (owner_id, name, industry)
    values (v_user_id, 'Lakeside Painting', 'painting')
    returning id into v_biz_id;
  end if;

  -- Seed GST settings from the Finances sheet defaults.
  insert into settings (business_id, key, value, notes) values
    (v_biz_id, 'gst_mode',           'on',   'on/off (controls default GST behaviour in automations)'),
    (v_biz_id, 'gst_rate',           '0.15', 'NZ GST rate (15%)'),
    (v_biz_id, 'gst_effective_date', '',     'Optional. YYYY-MM-DD. Used to decide claimable GST later')
  on conflict (business_id, key) do nothing;

  raise notice 'Seed complete. Business id: %', v_biz_id;
end $$;
