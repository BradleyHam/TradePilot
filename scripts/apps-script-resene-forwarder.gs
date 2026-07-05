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
//   4. In the editor, select processReseneBills and hit Run once —
//      Google will ask you to authorize Gmail + external-request access.
//      The first run also picks up the backlog (last 14 days).
//   5. Clock icon (Triggers) → Add Trigger:
//        function: processReseneBills · event: time-driven · every 30 minutes.
//
// Idempotency / retries: processed threads get the Gmail label
// "TradePilot-sent". Anything that fails stays unlabelled and is retried
// on the next run; the webhook's Message-ID dedupe prevents duplicates.

var SEARCH_QUERY = 'from:einvoice@resene.co.nz has:attachment newer_than:14d -label:TradePilot-sent';
var SENT_LABEL = 'TradePilot-sent';
var MAX_THREADS_PER_RUN = 20;

function processReseneBills() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');
  if (!url || !secret) {
    throw new Error('Set WEBHOOK_URL and WEBHOOK_SECRET in Project Settings → Script Properties.');
  }

  var label = GmailApp.getUserLabelByName(SENT_LABEL) || GmailApp.createLabel(SENT_LABEL);
  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS_PER_RUN);
  console.info('Found ' + threads.length + ' unprocessed Resene thread(s)');

  threads.forEach(function (thread) {
    var allOk = true;
    thread.getMessages().forEach(function (msg) {
      try {
        if (!sendToWebhook(msg, url, secret)) allOk = false;
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

function sendToWebhook(msg, url, secret) {
  var pdfs = msg
    .getAttachments({ includeInlineImages: false, includeAttachments: true })
    .filter(function (a) {
      var name = (a.getName() || '').toLowerCase();
      return a.getContentType() === 'application/pdf' || name.slice(-4) === '.pdf';
    });
  if (pdfs.length === 0) {
    console.warn('No PDF on message ' + msg.getId() + ' — skipping');
    return true; // nothing to send; don't hold the thread hostage
  }

  // Message-ID drives the webhook's dedupe. Fall back to the Gmail id
  // (stable per message) if the header is somehow missing.
  var messageId = msg.getHeader('Message-ID')
    || ('<apps-script-' + msg.getId() + '@lakesidepainting>');

  var payload = {
    envelope: { from: 'einvoice@resene.co.nz', to: 'apps-script-direct' },
    headers: {
      message_id: messageId,
      subject: msg.getSubject(),
      from: msg.getFrom(),
    },
    plain: msg.getPlainBody().slice(0, 5000),
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
