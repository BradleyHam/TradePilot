-- =============================================================
-- Migration 042 — job_contacts (one row per contact, in either direction)
-- =============================================================
-- `jobs.last_contacted_date` (012) answers "when did I last chase this?" and
-- nothing else. It's a single overwritable slot: every chase erases the one
-- before it. That's exactly the right shape for the chase-list badge, and
-- exactly the wrong shape for "how many touches does a won job take, and what
-- gap between them actually works?" — the history it would need was being
-- thrown away on every write.
--
-- This table keeps the history. `last_contacted_date` STAYS, maintained by the
-- app as a derived cache of the newest row here, so the chase-list, the
-- follow-up ladder and the lead temperature sort keep working untouched and
-- this migration can't break them. If the two ever disagree, this table wins.
--
-- ## Direction is the whole point
--
-- Outbound-only data can tell you how often Brad chased, but not whether it
-- worked. `direction = 'in'` — the customer came back to us — is the response
-- signal, and the gap between an 'out' row and the next 'in' row on the same
-- job is the answer to "how long should I wait before chasing again?".
--
-- ## Why no rigid channel enum
--
-- A check constraint here would mean a migration every time a new way of
-- talking to people shows up. The values are app-side vocabulary (see
-- ContactChannel in lib/types.ts) and the column stays plain text — same
-- reasoning as `declined_from_status` in 040. Unknown/legacy rows carry
-- 'unknown' rather than null, so grouping never has a mystery bucket.

create table if not exists job_contacts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade not null,
  job_id        uuid references jobs(id) on delete cascade not null,
  -- When the contact happened — NOT when the row was written. The quote
  -- catch-up flow backdates ("I sent that quote last Tuesday"), so these two
  -- genuinely differ and `created_at` can't stand in for it.
  contacted_at  timestamptz not null default now(),
  -- 'out' = Brad contacted them. 'in' = they came back to him.
  -- Constrained, unlike channel: this one is a closed set by definition, and
  -- every duration calculation depends on it being exactly one of the two.
  direction     text not null default 'out' check (direction in ('out', 'in')),
  -- 'phone' | 'email' | 'text' | 'visit' | 'quote-sent' | 'other' | 'unknown'.
  channel       text not null default 'unknown',
  -- Optional free text. Deliberately not required — the whole design goal is
  -- that logging a contact costs zero extra taps, and a mandatory note would
  -- put a keyboard between Brad and the button.
  note          text,
  logged_by     uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

-- (job_id, contacted_at desc) serves both reads: the per-job timeline on the
-- detail sheet, and "newest contact for this job" when rebuilding the cache.
create index if not exists job_contacts_job_idx
  on job_contacts(job_id, contacted_at desc);
create index if not exists job_contacts_business_idx
  on job_contacts(business_id, contacted_at desc);

alter table job_contacts enable row level security;

-- Owner-only. Who Brad is chasing and how hard is commercial information, it
-- has no on-site use, and it isn't exposed via jobs_public — so no employee
-- policies and no view rebuild (same call as the snooze migration).
drop policy if exists "owner manages job contacts" on job_contacts;
create policy "owner manages job contacts"
  on job_contacts for all
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

-- ── Backfill: one row per job that has ever been contacted ────────────────
-- All we know about the past is the single surviving timestamp, so that's all
-- we claim: direction 'out' (the column only ever meant "Brad touched them"),
-- channel 'unknown' rather than a guess, and no note. One row per job, so the
-- history starts honest — thin, but not invented.
--
-- `where not exists` makes this re-runnable and stops a second run from
-- duplicating the seed row after real contacts have been logged.
insert into job_contacts (business_id, job_id, contacted_at, direction, channel, note)
select j.business_id, j.id, j.last_contacted_date, 'out', 'unknown',
       'Backfilled from the old single last-contacted date — channel unknown.'
  from jobs j
 where j.last_contacted_date is not null
   and not exists (select 1 from job_contacts c where c.job_id = j.id);
