-- 021_bill_groups.sql
-- Links the slices of ONE supplier bill that was split across multiple jobs
-- at confirm time. Every sibling `bill` entry created from the same invoice
-- shares this id; a normal single-job bill leaves it null. Lets us keep the
-- slices together for display, exempt them from duplicate detection, and
-- reconcile a payment against the whole group.

alter table entries
  add column if not exists bill_group_id uuid;

create index if not exists entries_bill_group_idx
  on entries (business_id, bill_group_id)
  where bill_group_id is not null;
