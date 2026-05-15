-- =============================================================
-- Migration 006 — Inbound bill webhook idempotency
-- =============================================================
-- Adds a nullable `source_message_id` column to `entries` so the
-- /api/webhooks/inbound-bill route can dedupe by the email's Message-ID
-- header. CloudMailin (or any inbound mail provider) may retry deliveries
-- on failure; without this we'd create a duplicate draft each time.
--
-- Nullable so existing entries (manual uploads, legacy imports, etc.)
-- aren't affected. Only inbound-webhook entries set it.

alter table entries
  add column if not exists source_message_id text;

-- Partial index — only inbound entries have this column populated, so a
-- regular index would be sparse. Speeds up the "have we seen this email
-- already?" lookup in the webhook.
create unique index if not exists entries_source_message_id_uniq
  on entries(business_id, source_message_id)
  where source_message_id is not null;
