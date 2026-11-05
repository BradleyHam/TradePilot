# Incoming enquiry scanner

Run under info@lakesidepainting.co.nz in a dedicated Apps Script project, with the supplied manifest (Gmail read-only and external-request scopes only). Configure LEAD_WEBHOOK_URL, LEAD_WEBHOOK_SECRET, lead_start_ms and lead_cursor_ms in Script Properties; the start/cursor should be the reviewed audit cutoff, not an arbitrary historical replay. After the production endpoint is deployed, enable Gmail v1, approve the exact Google scopes, run dryRunEmailLeads, then processEmailLeads once and verify the database and Gmail ledger. Only then schedule processEmailLeads every five minutes with immediate failure notifications.

The scanner reads incoming message text including Spam, excluding Sent, Draft and Trash, and sends it to TradePilot's Anthropic classifier. Attachments remain in Gmail; each captured message links to the original. Message IDs are recorded only after successful delivery. Overlapping cursors, a script lock, bounded batches and a four-minute processing budget allow safe retries.

The endpoint stores durable per-message receipts, deterministic job/contact IDs, and thread markers. New additional work is kept separate. Replies link to a known thread or an unambiguous customer/address; ambiguous replies create a review lead. This does not automatically accept/decline jobs or change financial records. Confident non-enquiries are skipped; uncertain messages and parser outages remain visible for review. Classification can still make mistakes: audit real messages periodically.

Successful scans send a content-free heartbeat. The existing daily Vercel notification check warns via registered TradePilot push devices if the last successful scan is over two hours old. This is a daily independent check, not instant outage detection; Apps Script failure emails provide the faster signal. A deleted trigger cannot send its own failure emails.

Google API terms and new mailbox permission require action-time user confirmation. Do not enable a trigger before delivery is verified. Tests: node scripts/test-email-lead-forwarder.mjs; node --import tsx scripts/test-email-lead-routing.ts; node --import tsx scripts/test-email-lead-dedup.ts.
