-- =============================================================
-- Migration 044 — web push notifications
-- =============================================================
--
-- Two tables behind the push-notification system (feature #4 on the
-- roadmap — "Tomorrow: McLeod 8am, Dulux bill due"):
--
--   push_subscriptions — one row per browser/device that turned
--     notifications on in Settings. Stores the push endpoint URL plus
--     the two client keys (p256dh, auth) that RFC 8291 payload
--     encryption needs. Endpoint is globally unique by construction
--     (it's a per-subscription URL minted by Apple/Google), so it's
--     the natural upsert key — re-enabling on the same device updates
--     the row instead of duplicating it.
--
--   notification_log — one row per notification actually sent, with a
--     UNIQUE (business_id, rule_key, dedupe_key) constraint that IS
--     the dedupe mechanism: the sender claims the key with an
--     `insert ... on conflict do nothing` BEFORE sending, so a rule
--     fires exactly once per subject per state (e.g. quote-promise
--     J42:2026-08-14:t1) even if the cron overlaps or re-runs.
--     Repeat-nagging is the fastest way to get notifications ignored
--     or turned off — rules escalate through NEW keys, never re-fire
--     old ones.
--
-- RLS: owner-only on both, matching pay_runs (money-blindness ethos:
-- employees never see Brad's device registrations or what the app is
-- nudging him about). The cron route + webhooks write via the
-- service-role key, same as every other server-side pipeline.

create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  -- Purely diagnostic — "which device is this?" when pruning.
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;

create policy "Owner manages push subscriptions"
  on push_subscriptions for all
  using (
    business_id in (select id from businesses where owner_id = auth.uid())
  )
  with check (
    business_id in (select id from businesses where owner_id = auth.uid())
  );

create table if not exists notification_log (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  -- e.g. 'morning-digest', 'quote-promise', 'lead-arrived', 'ei-filing'
  rule_key     text not null,
  -- Rule-defined once-only key, e.g. '<jobId>:2026-08-14:t1' or a date.
  dedupe_key   text not null,
  title        text not null,
  body         text,
  url          text,
  sent_at      timestamptz not null default now(),
  unique (business_id, rule_key, dedupe_key)
);

alter table notification_log enable row level security;

-- Owner can read the history (future "what did it send me?" screen);
-- writes come from the service-role sender only.
create policy "Owner reads notification log"
  on notification_log for select
  using (
    business_id in (select id from businesses where owner_id = auth.uid())
  );
