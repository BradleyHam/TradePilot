// Local preparation only. Install in a dedicated Apps Script project only
// after the email-lead endpoint supports message-identity deduplication.
// A run reads all incoming message bodies, including spam, and sends them to
// TradePilot for classification; see README.md before authorising access.
var LEAD_CURSOR = 'lead_cursor_ms';
var LEAD_START = 'lead_start_ms';
var LEAD_DELIVERED = 'lead_message_';
var LEAD_BATCH_SIZE = 75;
var LEAD_PAGE_SIZE = 100;
var LEAD_MAX_PAGES = 100;
// Keep an overlapping window for Gmail's delayed search indexing.
var LEAD_OVERLAP_MS = 24 * 60 * 60 * 1000;

function leadHeader_(headers, name) {
  var found = (headers || []).filter(function (h) { return h.name.toLowerCase() === name; });
  if (found.length > 1) throw new Error('Ambiguous email header; retry pending.');
  return found.length ? found[0].value : '';
}

function leadBody_(messageId, part, mime) {
  if (!part) return '';
  if (part.mimeType === mime && part.body) {
    var data = part.body.data;
    if (!data && part.body.attachmentId) data = Gmail.Users.Messages.Attachments.get('me', messageId, part.body.attachmentId).data;
    if (data) return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
  }
  var children = part.parts || [];
  for (var i=0; i<children.length; i++) {
    var body = leadBody_(messageId, children[i], mime);
    if (body) return body;
  }
  return '';
}

function leadMessages_(cursor, start) {
  var query = 'after:' + Math.floor(Math.max(0, cursor - LEAD_OVERLAP_MS) / 1000);
  var ids = {}, items = [], token, pages = 0;
  do {
    if (++pages > LEAD_MAX_PAGES) throw new Error('Lead mailbox backlog exceeds scan limit; no cursor advanced.');
    var opts = {q: query, includeSpamTrash: true, maxResults: LEAD_PAGE_SIZE};
    if (token) opts.pageToken = token;
    var page = Gmail.Users.Messages.list('me', opts);
    (page.messages || []).forEach(function (item) { ids[item.id] = true; });
    token = page.nextPageToken;
  } while (token);
  Object.keys(ids).forEach(function (id) {
    var meta = Gmail.Users.Messages.get('me', id, {format:'metadata', fields:'id,internalDate,labelIds'});
    var labels = meta.labelIds || [];
    var time = Number(meta.internalDate);
    if (!Number.isFinite(time) || !/^[a-z0-9_-]{1,200}$/i.test(id)) throw new Error('Invalid message metadata.');
    if (time < start || time < cursor - LEAD_OVERLAP_MS || labels.indexOf('SENT') >= 0 || labels.indexOf('DRAFT') >= 0 || labels.indexOf('TRASH') >= 0) return;
    items.push({id:id, time:time});
  });
  return items.sort(function (a,b) { return a.time - b.time || a.id.localeCompare(b.id); });
}

function dryRunEmailLeads() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(LEAD_CURSOR);
  var start = Number(props.getProperty(LEAD_START));
  if (!raw || !Number.isFinite(Number(raw)) || !Number.isFinite(start) || start <= 0) throw new Error('Set the starting cursor before a dry run.');
  var messages = leadMessages_(Number(raw), start);
  console.info('Incoming messages to assess: ' + messages.length + '. Nothing sent or changed.');
}

function processEmailLeads() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('A lead mailbox run is already active.');
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(LEAD_CURSOR), cursor = Number(raw);
    var start = Number(props.getProperty(LEAD_START));
    var url = props.getProperty('LEAD_WEBHOOK_URL'), secret = props.getProperty('LEAD_WEBHOOK_SECRET');
    if (!raw || !Number.isFinite(cursor) || cursor <= 0 || !Number.isFinite(start) || start <= 0) throw new Error('Missing lead cursor.');
    if (url !== 'https://trade-pilot-ochre.vercel.app/api/webhooks/inbound-email-lead' || !secret) throw new Error('Missing or invalid lead webhook configuration.');
    var started = Date.now();
    var messages = leadMessages_(cursor, start), delivered = 0;
    for (var i=0; i<messages.length && delivered<LEAD_BATCH_SIZE && Date.now()-started < 240000; i++) {
      var item = messages[i], key = LEAD_DELIVERED + item.id;
      if (props.getProperty(key)) continue;
      var msg = Gmail.Users.Messages.get('me', item.id, {format:'full'});
      var part = msg.payload || {}, headers = part.headers || [];
      var subject = leadHeader_(headers, 'subject') || '(No subject)';
      var plain = leadBody_(item.id, part, 'text/plain');
      var payload = {headers:{'Message-ID': leadHeader_(headers, 'message-id') || '<gmail-' + item.id + '@tradepilot.local>', from:leadHeader_(headers, 'from'), subject:subject}, subject:subject, plain:plain.slice(0,40000), html:plain ? '' : leadBody_(item.id, part, 'text/html').slice(0,40000), gmail_message_id:item.id, gmail_thread_id:msg.threadId, received_at:new Date(item.time).toISOString()};
      var response = UrlFetchApp.fetch(url, {method:'post', contentType:'application/json', headers:{'x-webhook-secret':secret}, payload:JSON.stringify(payload), muteHttpExceptions:true, followRedirects:false});
      var result;
      try { result = JSON.parse(response.getContentText()); } catch (e) { throw new Error('Unrecognised lead webhook response; retry pending.'); }
      if (response.getResponseCode() !== 200 || result.ok !== true) throw new Error('Lead webhook failed; retry pending.');
      props.setProperty(key, String(item.time));
      delivered++;
    }
    // Advance only after all messages through the batch boundary were handled.
    // The overlap and per-message ledger cover equal timestamps and late indexing.
    var last = cursor;
    var j;
    for (j=0; j<messages.length; j++) {
      if (!props.getProperty(LEAD_DELIVERED + messages[j].id)) break;
      last = Math.max(last, messages[j].time);
    }
    if (j === messages.length) last = Math.max(last, started - LEAD_OVERLAP_MS);
    props.setProperty(LEAD_CURSOR, String(last));
    var old = props.getProperties();
    Object.keys(old).forEach(function (key) {
      if (key.indexOf(LEAD_DELIVERED) === 0 && Number(old[key]) < last - 7 * 86400000) props.deleteProperty(key);
    });
    var heartbeat = UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',headers:{'x-webhook-secret':secret},payload:JSON.stringify({scanner_heartbeat:true}),muteHttpExceptions:true,followRedirects:false});
    if (heartbeat.getResponseCode() !== 200 || JSON.parse(heartbeat.getContentText()).ok !== true) throw new Error('Lead heartbeat failed.');
    console.info('Assessed ' + delivered + ' incoming message(s).');
  } finally { lock.releaseLock(); }
}
