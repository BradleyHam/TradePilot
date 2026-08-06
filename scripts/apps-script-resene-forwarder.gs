// TradePilot — Resene bill forwarder (Google Apps Script)
//
// Why this exists: Resene invoice emails are >512KB, which is over
// CloudMailin's free-plan per-message size limit, so the normal
// Gmail-filter → CloudMailin → TradePilot pipeline bounces them
// ("552 Message size exceeds the allowed size for this account").
// This script bypasses CloudMailin entirely: it finds Resene invoice
// emails in Gmail and POSTs a CloudMailin-shaped JSON payload (PDF
// base64-encoded) directly to the TradePilot inbound-bill webhook.
// The webhook dedupes on Message-ID, so re-runs are always safe.
//
// Lives in the repo for reference only — it RUNS at script.google.com
// under the info@lakesidepainting.co.nz Google account.
//
// Setup (one-off, ~3 minutes):
//   1. Go to script.google.com while signed in as info@lakesidepainting.co.nz
//      → New project. Name it "TradePilot Resene forwarder".
//   2. Replace the default Code.gs contents with this file. Save.
//   3. Gear icon (Project Settings) → Script Properties → Add:
//        WEBHOOK_URL    = https://trade-pilot-ochre.vercel.app/api/webhooks/inbound-bill
//        WEBHOOK_SECRET = <INBOUND_BILL_WEBHOOK_SECRET from TradePilot .env.local>
//   4. Select dryRunReseneBills and hit Run. Google will ask you to
//      authorize Gmail + external-request access. Nothing is sent —
//      read the Execution log to see what a real run WOULD forward.
//   5. Happy with the list? Select processReseneBills and Run.
//      The first real run also picks up the backlog (last 14 days).
//   6. Clock icon (Triggers) → Add Trigger:
//        function: processReseneBills · event: time-driven · every 30 minutes.
//
// Idempotency / retries: processed threads get the Gmail label
// "TradePilot-sent". Anything that fails stays unlabelled and is retried
// on the next run; the webhook's Message-ID dedupe prevents duplicates.
//
// IMPORTANT — this file is a COPY. Editing it here changes nothing until
// the contents are pasted back into the Apps Script project. If an invoice
// stops arriving, check the Executions log at script.google.com first.
//
// Also worth knowing: this only ever sees mail in the Gmail account the
// script is authorised against. An invoice delivered to a different
// mailbox is invisible to it no matter what SEARCH_QUERY says.

// Match the whole DOMAIN, not one mailbox.
//
// This used to be `from:einvoice@resene.co.nz`, and it silently stopped
// working the moment Resene sent an invoice from `accounts@resene.co.nz`
// instead — the Gmail search simply didn't match, so nothing was POSTed,
// nothing was logged, and no failure draft appeared in the app. The first
// anyone knew was noticing an invoice that never turned up.
// `from:resene.co.nz` covers einvoice@, accounts@, noreply@ and whatever
// they switch to next.
//
// `subject:invoice` replaces the old `has:attachment`. Two reasons:
//   - Dropping has:attachment lets link-only invoices through to the
//     webhook's link-follower / failure-draft path instead of vanishing.
//   - But the domain now also matches payment confirmations, myResene
//     account notices and the TradeTalk newsletter, none of which are
//     bills. Without a subject filter each of those becomes a junk
//     "needs attention" draft on Home. Every Resene invoice email — from
//     either sender — has "Invoice" in the subject.
var SEARCH_QUERY = 'from:resene.co.nz subject:invoice newer_than:14d -label:TradePilot-sent';
var SENT_LABEL = 'TradePilot-sent';
var MAX_THREADS_PER_RUN = 20;

// ── Invoice-number dedupe ───────────────────────────────────────────────
// Resene sends the SAME invoice twice, from two addresses: once from
// einvoice@ on the day, and again from accounts@ in a periodic catch-up
// batch. Those are two separate emails with two different Message-IDs, so
// the webhook's Message-ID dedupe does NOT catch them — re-forwarding the
// batch would file every invoice a second time and quietly overstate
// costs.
//
// So we dedupe on the invoice number in the subject as well, tracked in
// Script Properties (survives runs; invisible to Gmail).
//
// SEEDED_INVOICES are the invoice numbers known to be in the app already
// at the time this dedupe was added (July 2026) — they were ingested from
// einvoice@ before the accounts@ re-sends arrived. Seeding them means the
// first run after this change skips the re-sends instead of duplicating
// them. Harmless to leave in place forever.
var SEEDED_INVOICES = [
  '424763500', // 26 Jun
  '424769024', // 29 Jun
  '424771838', // 30 Jun
  '425300832', // 13 Jul
  '425310813', // 16 Jul
];
var INVOICE_PROP_PREFIX = 'inv_';

/**
 * Dry run — lists what a real run WOULD send, and sends nothing.
 *
 * Worth having because the failure mode here is expensive and invisible:
 * a bad SEARCH_QUERY that matches too much files phantom bills against
 * real jobs, and nobody notices until the numbers look wrong. Run this
 * first after changing the query or the seed list.
 *
 * Select `dryRunReseneBills` in the Apps Script editor and hit Run, then
 * read the Execution log.
 */
function dryRunReseneBills() {
  var props = PropertiesService.getScriptProperties();
  seedInvoiceLedger(props);
  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS_PER_RUN);
  console.info('DRY RUN — query: ' + SEARCH_QUERY);
  console.info('Matched ' + threads.length + ' thread(s)');
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var invoiceNo = invoiceNumberFrom(msg.getSubject());
      var already = invoiceNo && props.getProperty(INVOICE_PROP_PREFIX + invoiceNo);
      var pdfs = pdfAttachments(msg);
      console.info(
        (already ? 'SKIP (invoice already sent) ' : 'WOULD SEND ')
        + '· ' + msg.getDate().toDateString()
        + ' · ' + msg.getFrom()
        + ' · inv ' + (invoiceNo || '?')
        + ' · ' + pdfs.length + ' PDF(s)'
        + ' · "' + msg.getSubject() + '"',
      );
    });
  });
  console.info('DRY RUN complete — nothing was sent.');
}

function processReseneBills() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');
  if (!url || !secret) {
    throw new Error('Set WEBHOOK_URL and WEBHOOK_SECRET in Project Settings → Script Properties.');
  }

  seedInvoiceLedger(props);

  var label = GmailApp.getUserLabelByName(SENT_LABEL) || GmailApp.createLabel(SENT_LABEL);
  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS_PER_RUN);
  console.info('Found ' + threads.length + ' unprocessed Resene thread(s)');

  threads.forEach(function (thread) {
    var allOk = true;
    thread.getMessages().forEach(function (msg) {
      try {
        var invoiceNo = invoiceNumberFrom(msg.getSubject());
        if (invoiceNo && props.getProperty(INVOICE_PROP_PREFIX + invoiceNo)) {
          console.info('Invoice ' + invoiceNo + ' already sent — skipping "'
            + msg.getSubject() + '"');
          return; // counts as OK; the thread can be labelled
        }
        if (!sendToWebhook(msg, url, secret)) {
          allOk = false;
          return;
        }
        // Record only AFTER a confirmed 200, so a failed POST is retried
        // next run rather than being marked done.
        if (invoiceNo) props.setProperty(INVOICE_PROP_PREFIX + invoiceNo, new Date().toISOString());
      } catch (e) {
        allOk = false;
        console.error('Failed for message ' + msg.getId() + ': ' + e);
      }
    });
    // Only label the thread when every message went through — unlabelled
    // threads are retried next run (webhook dedupe makes that safe).
    if (allOk) thread.addLabel(label);
  });
}

/** Pull the Resene invoice number out of a subject line, or null.
 *  Handles both formats: "Resene | Invoice 425319907" (accounts@) and
 *  "Your Invoice 425310813  from Resene (Account: D69359)" (einvoice@). */
function invoiceNumberFrom(subject) {
  var m = /invoice\s+(\d{6,})/i.exec(subject || '');
  return m ? m[1] : null;
}

/** Write the seed list into the ledger once, so invoices already in the
 *  app before invoice-level dedupe existed are never re-sent. Runs every
 *  time but only writes what's missing, so it's cheap and idempotent. */
function seedInvoiceLedger(props) {
  SEEDED_INVOICES.forEach(function (n) {
    var key = INVOICE_PROP_PREFIX + n;
    if (!props.getProperty(key)) props.setProperty(key, 'seeded');
  });
}

/** PDF attachments on a message. Shared by the dry run and the real send
 *  so the preview can't drift from what actually gets forwarded. */
function pdfAttachments(msg) {
  return msg
    .getAttachments({ includeInlineImages: false, includeAttachments: true })
    .filter(function (a) {
      var name = (a.getName() || '').toLowerCase();
      return a.getContentType() === 'application/pdf' || name.slice(-4) === '.pdf';
    });
}

function sendToWebhook(msg, url, secret) {
  var pdfs = pdfAttachments(msg);
  // No PDF? POST it anyway. The old behaviour was to skip AND return true,
  // which labelled the thread TradePilot-sent — so the email was dropped
  // permanently, with no retry and nothing visible anywhere. The webhook
  // has a fallback chain for attachment-less mail (follow a download link,
  // parse the body) and, failing all that, files an amber "needs attention"
  // draft on Home. A visible draft beats a silent skip every time.
  if (pdfs.length === 0) {
    console.warn('No PDF on message ' + msg.getId() + ' — forwarding anyway for the '
      + 'webhook to link-follow / parse / raise as a draft');
  }

  // Message-ID drives the webhook's dedupe. Fall back to the Gmail id
  // (stable per message) if the header is somehow missing.
  var messageId = msg.getHeader('Message-ID')
    || ('<apps-script-' + msg.getId() + '@lakesidepainting>');

  // Real sender, not a hard-coded one. The envelope address is what the
  // webhook labels a failure draft with — stamping every message as
  // "einvoice@resene.co.nz" meant a draft raised from an accounts@ email
  // pointed at the wrong mailbox when you went looking for the original.
  var payload = {
    envelope: { from: msg.getFrom(), to: 'apps-script-direct' },
    headers: {
      message_id: messageId,
      subject: msg.getSubject(),
      from: msg.getFrom(),
    },
    // The body matters more now that attachment-less mail is forwarded:
    // it's what the link-follower scans for a download URL.
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
