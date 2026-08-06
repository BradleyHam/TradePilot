// TradePilot — sent-quote forwarder (Google Apps Script)
//
// Why this exists: when Brad emails a customer a quote from Gmail, the app
// has no idea it happened — the lead sits in "Leads to contact" / "New
// enquiries" looking un-actioned, and the quote follow-up ladder never
// starts. Gmail filters can't act on SENT mail, so this script polls the
// Sent folder on a timer (same pattern as the Resene bill forwarder) and
// POSTs each quote email — PDF included — to the TradePilot
// inbound-quote-sent webhook. The webhook matches the email to the lead,
// parses the PDF for the total, flips the job to "Quoted, awaiting reply",
// attaches the PDF, and logs the contact. No matching lead → the job is
// created as quoted so nothing slips through.
//
// Lives in the repo for reference only — it RUNS at script.google.com
// under the info@lakesidepainting.co.nz Google account (the account the
// quotes are SENT from; the script only sees that mailbox's Sent folder).
//
// ── Design lessons from the first dry run (Aug 2026) ────────────────────
// 1. Gmail search matches THREADS, not messages. One quote PDF matched a
//    thread and every "Re:" reply in it — including months-old messages
//    (newer_than applies to the thread's latest activity) — would have
//    been forwarded. So eligibility is decided PER MESSAGE, in code.
// 2. Bare search terms match email BODIES. `(quote OR estimate)` pulled in
//    a health-and-safety email with 8 PDFs because its body mentioned
//    "quote". So the query stays broad (in:sent filename:pdf) and the
//    REAL filter is the attachment name: Brad's quotes are always named
//    "Quote QUO-0XX - Client - Job.pdf" (isQuotePdfName below). Only the
//    quote-named PDFs are forwarded — never other files on the message.
// 3. Dedupe is PER MESSAGE (Script Properties ledger keyed by message id,
//    recorded only after a confirmed 200), NOT a thread label. A thread
//    label would permanently mute a thread — and a revised quote sent
//    later in the same thread would be silently missed.
//
// Setup (one-off, ~3 minutes):
//   1. script.google.com signed in as info@lakesidepainting.co.nz
//      → New project → name it "TradePilot quote forwarder".
//   2. Replace Code.gs with this file. Save.
//   3. Gear icon (Project Settings) → Script Properties → Add:
//        WEBHOOK_URL    = https://trade-pilot-ochre.vercel.app/api/webhooks/inbound-quote-sent
//        WEBHOOK_SECRET = <QUOTE_SENT_WEBHOOK_SECRET from TradePilot .env.local>
//   4. Run dryRunSentQuotes → authorize → check the log lists real quotes only.
//   5. Run processSentQuotes once (AFTER the Vercel deploy + env var).
//   6. Triggers (clock icon) → Add Trigger:
//        processSentQuotes · time-driven · every 30 minutes.
//
// IMPORTANT — this file is a COPY. Editing it here changes nothing until
// pasted back into script.google.com. If quotes stop syncing, check the
// Executions log there FIRST — there is no in-app symptom when a poller
// dies (same as the Resene forwarder).

// Broad on purpose — precision comes from isQuotePdfName() below, not the
// query (lesson 2 above). MAX_MESSAGE_AGE_DAYS mirrors newer_than so a
// thread's old messages don't ride in on new activity (lesson 1).
var SEARCH_QUERY = 'in:sent filename:pdf newer_than:7d';
var MAX_MESSAGE_AGE_DAYS = 7;
var MAX_THREADS_PER_RUN = 25;
var SENT_PROP_PREFIX = 'qs_'; // per-message ledger key prefix

/** Does this attachment name look like one of Brad's quote PDFs?
 *  Matches "Quote QUO-050 - ...", "QUO-051 ...", "quote.pdf" etc. */
function isQuotePdfName(name) {
  return /quote|quo[-_ ]?\d/i.test(name || '');
}

/**
 * Dry run — lists what a real run WOULD send, and sends nothing.
 * Run after ANY change to the query or predicates: the failure mode
 * (forwarding the wrong emails) is expensive and quiet.
 */
function dryRunSentQuotes() {
  var props = PropertiesService.getScriptProperties();
  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS_PER_RUN);
  console.info('DRY RUN — query: ' + SEARCH_QUERY);
  console.info('Scanned ' + threads.length + ' thread(s)');
  var eligible = 0;
  threads.forEach(function (thread) {
    eligibleMessages(thread).forEach(function (item) {
      var already = props.getProperty(SENT_PROP_PREFIX + item.msg.getId());
      if (!already) eligible++;
      console.info(
        (already ? 'SKIP (already sent) ' : 'WOULD SEND ')
        + '· ' + item.msg.getDate().toDateString()
        + ' · to ' + item.msg.getTo()
        + ' · ' + item.pdfs.length + ' quote PDF(s): '
        + item.pdfs.map(function (a) { return a.getName(); }).join(', ')
        + ' · "' + item.msg.getSubject() + '"',
      );
    });
  });
  console.info('DRY RUN complete — ' + eligible + ' message(s) would be sent. Nothing was sent.');
}

function processSentQuotes() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');
  if (!url || !secret) {
    throw new Error('Set WEBHOOK_URL and WEBHOOK_SECRET in Project Settings → Script Properties.');
  }

  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS_PER_RUN);
  var sent = 0;
  threads.forEach(function (thread) {
    eligibleMessages(thread).forEach(function (item) {
      var key = SENT_PROP_PREFIX + item.msg.getId();
      if (props.getProperty(key)) return; // already delivered
      try {
        if (sendToWebhook(item.msg, item.pdfs, url, secret)) {
          // Record only AFTER a confirmed 200 — failures retry next run,
          // and the webhook's content dedupe makes retries safe.
          props.setProperty(key, new Date().toISOString());
          sent++;
        }
      } catch (e) {
        console.error('Failed for message ' + item.msg.getId() + ': ' + e);
      }
    });
  });
  console.info('Run complete — ' + sent + ' quote email(s) forwarded.');
}

/**
 * The messages in this thread worth forwarding: sent by Brad, recent
 * (message-level age check — the thread being recent isn't enough), and
 * carrying at least one quote-named PDF. Returns [{msg, pdfs}] where pdfs
 * are ONLY the quote-named ones — H&S packs, consents and other PDFs on
 * the same message never leave the mailbox.
 */
function eligibleMessages(thread) {
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var cutoff = new Date(Date.now() - MAX_MESSAGE_AGE_DAYS * 24 * 60 * 60 * 1000);
  var out = [];
  thread.getMessages().forEach(function (msg) {
    var from = (msg.getFrom() || '').toLowerCase();
    if (from.indexOf(me) === -1) return;       // customer's reply, not Brad's
    if (msg.getDate() < cutoff) return;        // old message on a live thread
    var pdfs = msg
      .getAttachments({ includeInlineImages: false, includeAttachments: true })
      .filter(function (a) {
        var name = (a.getName() || '').toLowerCase();
        var isPdf = a.getContentType() === 'application/pdf' || name.slice(-4) === '.pdf';
        return isPdf && isQuotePdfName(name);
      });
    if (pdfs.length === 0) return;             // no quote PDF → not a quote email
    out.push({ msg: msg, pdfs: pdfs });
  });
  return out;
}

function sendToWebhook(msg, pdfs, url, secret) {
  var messageId = msg.getHeader('Message-ID')
    || ('<apps-script-' + msg.getId() + '@lakesidepainting>');

  var payload = {
    envelope: { from: msg.getFrom(), to: msg.getTo() },
    headers: {
      message_id: messageId,
      subject: msg.getSubject(),
      from: msg.getFrom(),
      to: msg.getTo(),
      cc: msg.getCc(),
    },
    // The webhook prefers the PDF's own issue date; sent_at is the fallback.
    sent_at: msg.getDate().toISOString(),
    plain: msg.getPlainBody().slice(0, 5000),
    html: msg.getBody().slice(0, 20000),
    attachments: pdfs.map(function (a) {
      var bytes = a.getBytes();
      return {
        file_name: a.getName(),
        content_type: 'application/pdf',
        content: Utilities.base64Encode(bytes),
        size: bytes.length,
      };
    }),
  };

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-webhook-secret': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = res.getResponseCode();
  if (code === 200) {
    console.info('Sent "' + msg.getSubject() + '" → ' + res.getContentText().slice(0, 200));
    return true;
  }
  console.error('Webhook returned ' + code + ' for "' + msg.getSubject() + '": '
    + res.getContentText().slice(0, 300));
  return false;
}
