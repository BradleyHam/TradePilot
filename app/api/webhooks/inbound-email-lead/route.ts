// POST /api/webhooks/inbound-email-lead
//
// Receives a forwarded customer enquiry from CloudMailin and creates a
// `lead`-status job in Trade Pilot with source='email'. This is for leads
// that DON'T come through the website contact form or Tapi — e.g. someone
// emails Lakeside directly, or Brad forwards on a referral. He forwards the
// email to this route's CloudMailin address and it lands in Jobs → Leads.
//
// Transport mirrors /api/webhooks/inbound-tapi-lead exactly (shared-secret
// auth, admin insert pinned to TRADEPILOT_BUSINESS_ID, retry dedup).
// The ONE difference is parsing: a forwarded human email has no fixed format,
// so we hand it to the LLM (lib/email-lead-parser.ts) rather than string-
// matching — same approach as the inbound-bill pipeline.
//
// Pipeline:
//   1. Auth via shared secret — `x-webhook-secret` header OR basic-auth in
//      the URL (CloudMailin free tier can't set custom headers).
//   2. Parse the CloudMailin JSON payload (subject, plain, html, from).
//   3. LLM-parse the email into lead fields. If the model is confident it's
//      NOT a customer enquiry, accept-and-ignore (200 + skipped) so a stray
//      forward / newsletter doesn't create junk.
//   4. Dedupe recent retries by the original Message-ID. Never suppress a
//      different enquiry just because the same customer contacted us again.
//   5. Insert status='lead', source='email' via the admin (service-role)
//      client (an inbound webhook has no auth.uid()).
//
// Never-drop-a-lead rule: if the parser THROWS (API outage, etc.) we still
// insert a minimal "needs review" lead carrying the raw email, rather than
// 5xx-ing and risking the enquiry vanishing. Matches the inbound-bill route's
// "nothing silently disappears" behaviour.

import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import {
  parseEmailLead,
  buildEmailLeadFields,
  type EmailLeadFields,
} from '@/lib/email-lead-parser';
import { emailLeadJobId, emailLeadMessageMarker } from '@/lib/email-lead-dedup';
import { quoteToRow, quoteAttachmentToRow } from '@/lib/supabase/mappers';
import { webhookRequestAuthenticated } from '@/lib/webhook-auth';
import { sendBusinessNotificationSafe } from '@/lib/push-notify';
import { matchEmailJob } from '@/lib/email-lead-routing';
import type { QuoteAttachmentKind } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CloudMailinPayload {
  envelope?: { from?: unknown; to?: unknown };
  headers?: Record<string, unknown>;
  plain?: unknown;
  html?: unknown;
  subject?: unknown;
  gmail_message_id?: unknown;
  gmail_thread_id?: unknown;
  received_at?: unknown;
  scanner_heartbeat?: unknown;
  attachments?: unknown;
}

// CloudMailin v0.4 attachment shape (same transport as inbound-bill). We read
// `disposition` + `content_id` too so we can skip inline signature/logo images
// (those are embedded via `cid:` refs in the HTML body, not real enquiry files).
interface CloudMailinAttachment {
  file_name?: unknown;
  content_type?: unknown;
  content?: unknown; // base64-encoded
  size?: unknown;
  disposition?: unknown;
  content_id?: unknown;
}

// Guardrails so a hostile / oversized email can't blow up storage.
const MAX_LEAD_ATTACHMENTS = 12;
const MAX_LEAD_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per file

/**
 * Pick a `quote_attachments.kind` for an enquiry file. Mirrors the app's own
 * `inferAttachmentKind` (lib/store.tsx) but biased for the LEAD context: an
 * emailed enquiry PDF is almost always a plan/drawing, and an emailed photo is
 * showing us the work area (scope), so those are the sensible defaults.
 */
function inferLeadAttachmentKind(name: string, contentType?: string): QuoteAttachmentKind {
  const lower = name.toLowerCase();
  const ct = (contentType ?? '').toLowerCase();
  const isPdf = ct === 'application/pdf' || lower.endsWith('.pdf');
  if (isPdf) {
    if (lower.startsWith('q-') || lower.includes('quote')) return 'quote_pdf';
    if (lower.startsWith('inv-') || lower.includes('invoice')) return 'other';
    return 'plan'; // consent set, drawings, "consultant issue", etc.
  }
  const isImage = ct.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/.test(lower);
  if (isImage) {
    if (lower.includes('before') || lower.includes('start')) return 'before_photo';
    if (lower.includes('after') || lower.includes('final') || lower.includes('done')) return 'after_photo';
    if (lower.includes('progress') || lower.includes('during') || lower.includes('wip')) return 'process_photo';
    return 'scope_photo';
  }
  return 'other';
}

/**
 * Save any real enquiry attachments (photos, plan PDFs) onto a freshly-created
 * lead. Reuses the app's own storage convention exactly: a lead's files hang
 * off a stub `draft` quote linked to the job (same as `ensureJobHasQuote` in
 * the store), uploaded to the `quote-attachments` bucket at
 * `{businessId}/{quoteId}/{uuid}__{safeName}`. The JobDetailSheet's existing
 * "Plans + photos" panel then renders them with zero UI changes.
 *
 * Best-effort: never throws. A failure here must not lose the lead itself.
 * Inline signature/logo images (cid-referenced, disposition=inline) and
 * non-photo/non-PDF files are skipped.
 */
async function saveLeadAttachments(
  admin: SupabaseClient,
  businessId: string,
  jobId: string,
  jobLocation: string | undefined,
  rawAttachments: unknown,
): Promise<{ saved: number; skipped: number }> {
  const list = Array.isArray(rawAttachments) ? rawAttachments : [];
  if (list.length === 0) return { saved: 0, skipped: 0 };

  // Filter down to genuine enquiry files first, so we only spin up a stub
  // quote when there's actually something worth attaching.
  const keep: { buf: Buffer; fileName: string; contentType: string; kind: QuoteAttachmentKind }[] = [];
  let skipped = 0;
  for (const a of list) {
    if (keep.length >= MAX_LEAD_ATTACHMENTS) { skipped++; continue; }
    if (typeof a !== 'object' || a === null) { skipped++; continue; }
    const att = a as CloudMailinAttachment;

    const ct = asString(att.content_type)?.toLowerCase() ?? '';
    const fn = asString(att.file_name) ?? '';
    const disposition = asString(att.disposition)?.toLowerCase();
    const hasContentId = asString(att.content_id) != null;

    // Skip embedded signature/logo images referenced by the HTML body.
    if (disposition === 'inline' || hasContentId) { skipped++; continue; }

    const isPdf = ct === 'application/pdf' || fn.toLowerCase().endsWith('.pdf');
    const isImage = ct.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/.test(fn.toLowerCase());
    if (!isPdf && !isImage) { skipped++; continue; }

    const base64 = asString(att.content);
    if (!base64) { skipped++; continue; }
    let buf: Buffer;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      skipped++; continue;
    }
    if (buf.length === 0 || buf.length > MAX_LEAD_ATTACHMENT_BYTES) { skipped++; continue; }

    keep.push({
      buf,
      fileName: fn || (isPdf ? 'attachment.pdf' : 'photo.jpg'),
      contentType: ct || (isPdf ? 'application/pdf' : 'application/octet-stream'),
      kind: inferLeadAttachmentKind(fn, ct),
    });
  }

  if (keep.length === 0) return { saved: 0, skipped };

  // Stub quote to hang the files off — mirrors store.ensureJobHasQuote.
  const { data: quote, error: quoteErr } = await admin
    .from('quotes')
    .insert(quoteToRow({ businessId, jobId, jobAddress: jobLocation, status: 'draft' }))
    .select('id')
    .single();
  if (quoteErr || !quote) {
    console.error('[inbound-email-lead] stub quote insert failed — attachments skipped', quoteErr);
    return { saved: 0, skipped: skipped + keep.length };
  }
  const quoteId = quote.id as string;

  let saved = 0;
  for (const item of keep) {
    const safeName = item.fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const storagePath = `${businessId}/${quoteId}/${crypto.randomUUID()}__${safeName}`;
    const { error: upErr } = await admin.storage
      .from('quote-attachments')
      .upload(storagePath, item.buf, { contentType: item.contentType, upsert: false });
    if (upErr) {
      console.error('[inbound-email-lead] attachment upload failed for', item.fileName, upErr);
      skipped++;
      continue;
    }
    const { error: insErr } = await admin
      .from('quote_attachments')
      .insert(quoteAttachmentToRow({
        businessId,
        quoteId,
        kind: item.kind,
        storagePath,
        fileName: item.fileName,
      }));
    if (insErr) {
      console.error('[inbound-email-lead] attachment row insert failed for', item.fileName, insErr);
      // Don't leak the orphaned Storage object.
      await admin.storage.from('quote-attachments').remove([storagePath]).catch(() => {});
      skipped++;
      continue;
    }
    saved++;
  }

  return { saved, skipped };
}

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getAdminClient(): SupabaseClient | { error: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return { error: 'Server misconfigured: Supabase env vars missing.' };
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Authenticate via shared secret. Accepts the secret as an `x-webhook-secret`
 * header OR as basic-auth credentials in the URL
 * (`https://anything:<secret>@host/...`), matching either the username or
 * the password — same dual scheme as inbound-bill / inbound-tapi-lead so
 * CloudMailin's free tier (no custom headers) works.
 */
function isAuthenticated(req: Request, expectedSecret: string): boolean {
  // Constant-time comparison via the shared helper (lib/webhook-auth.ts).
  return webhookRequestAuthenticated(req, expectedSecret);
}

export async function POST(req: Request) {
  // ── 1. Authenticate ─────────────────────────────────────────────────────
  const expectedSecret = process.env.EMAIL_LEAD_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: EMAIL_LEAD_WEBHOOK_SECRET not set.' },
      { status: 500 },
    );
  }
  if (!isAuthenticated(req, expectedSecret)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid or missing webhook secret.' },
      { status: 401 },
    );
  }

  // ── 2. Resolve business id + admin client ───────────────────────────────
  const businessId = process.env.TRADEPILOT_BUSINESS_ID;
  if (!businessId) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: TRADEPILOT_BUSINESS_ID not set.' },
      { status: 500 },
    );
  }
  const adminOrErr = getAdminClient();
  if ('error' in adminOrErr) {
    return NextResponse.json({ ok: false, error: adminOrErr.error }, { status: 500 });
  }
  const admin = adminOrErr;

  // ── 3. Parse the payload ────────────────────────────────────────────────
  let body: CloudMailinPayload;
  try {
    body = (await req.json()) as CloudMailinPayload;
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }

  // Successful scans update a content-free heartbeat, even when no mail arrived.
  if (body.scanner_heartbeat === true) {
    const { error } = await admin.from('settings').upsert({business_id:businessId,
      key:'email_scanner_health', value:JSON.stringify({checkedAt:new Date().toISOString()})}, {onConflict:'business_id,key'});
    return NextResponse.json(error ? {ok:false,error:'Heartbeat could not be saved.'} : {ok:true}, {status:error ? 500 : 200});
  }

  const headers = (body.headers && typeof body.headers === 'object')
    ? (body.headers as Record<string, unknown>)
    : {};
  const subject =
    asString(body.subject) ?? asString(headers['subject']) ?? asString(headers['Subject']);
  const plain = asString(body.plain);
  const html = asString(body.html);
  const fromHeader =
    asString(headers['from']) ?? asString(headers['From']) ?? asString(body.envelope?.from);
  const rawGmailId = asString(body.gmail_message_id);
  const gmailId = rawGmailId && /^[a-z0-9_-]{1,200}$/i.test(rawGmailId) ? rawGmailId : undefined;

  if (!plain && !html && !subject) {
    return NextResponse.json(
      { ok: false, error: 'Empty email: need at least a subject or body.' },
      { status: 400 },
    );
  }

  const threadId = asString(body.gmail_thread_id);
  const threadMarker = threadId && /^[a-z0-9_-]{1,200}$/i.test(threadId) ? emailLeadMessageMarker(`thread:${threadId}`) : undefined;
  const identity = gmailId ? `gmail:${gmailId}` : asString(headers['Message-ID']) ?? asString(headers['message-id']);
  const receiptKey = identity ? `email_receipt_${crypto.createHash('sha256').update(identity).digest('hex')}` : undefined;
  const finish = async (result: Record<string, unknown>) => {
    if (receiptKey) {
      const {error} = await admin.from('settings').upsert({business_id:businessId,key:receiptKey,value:JSON.stringify(result)}, {onConflict:'business_id,key'});
      if (error) return NextResponse.json({ok:false,error:'Receipt could not be saved; retry pending.'},{status:500});
    }
    return NextResponse.json(result);
  };
  if (receiptKey) {
    const {data,error} = await admin.from('settings').select('value').eq('business_id',businessId).eq('key',receiptKey).maybeSingle();
    if (error) return NextResponse.json({ok:false,error:'Receipt lookup failed.'},{status:500});
    if (data?.value) return NextResponse.json({...JSON.parse(data.value),dedup:true});
  }

  // ── 4. LLM-parse → lead fields (never-drop fallback on failure) ──────────
  let lead: EmailLeadFields;
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let followUp = false;
  try {
    // An attachment-only message cannot be classified from text. Keep it for
    // review instead of quietly skipping a possible photo-based enquiry.
    if (gmailId && !plain && !html) throw new Error('Mailbox message has no readable body');
    const parsed = await parseEmailLead({ subject, plain, html, from: fromHeader });

    // Confident not-a-lead → accept-and-ignore so a stray forward/newsletter
    // doesn't create junk. A 200 stops CloudMailin retrying.
    if (!parsed.looksLikeLead && parsed.confidence === 'high' && parsed.messageKind !== 'follow-up') {
      console.info('[inbound-email-lead] skipped — model judged not a lead', {});
      return finish({ ok: true, skipped: true, reason: 'not-a-lead' });
    }

    confidence = parsed.confidence;
    followUp = parsed.messageKind === 'follow-up';
    lead = buildEmailLeadFields(parsed, { fromHeader, subject });
    if (!parsed.looksLikeLead && !followUp) {
      lead.notes += '\n\nPossible enquiry — the automatic check was uncertain. Please review the original email.';
    }
  } catch (err) {
    // Parser blew up (e.g. Anthropic outage). DO NOT drop the email — insert a
    // minimal lead carrying the raw content so Brad can action it by hand.
    console.error('[inbound-email-lead] parse failed; inserting fallback lead', err);
    lead = buildFallbackLead({ subject, plain, html, fromHeader });
  }

  // ── 5. Dedupe identical message deliveries within the recent window ────
  const messageId = asString(headers['message-id']) ?? asString(headers['Message-ID'])
    ?? asString(headers['message_id']);
  const marker = emailLeadMessageMarker(gmailId ? `gmail:${gmailId}` : messageId);
  const stableJobId = emailLeadJobId(businessId, marker);
  const originalLink = gmailId
    ? `https://mail.google.com/mail/u/?authuser=info%40lakesidepainting.co.nz#all/${gmailId}`
    : undefined;
  // Match source identity first, then a known conversation. Ambiguity stays visible.
  const {data:jobs,error:jobsError} = await admin.from('jobs').select('id,name,client_email,location,status,notes').eq('business_id',businessId);
  if (jobsError) return NextResponse.json({ok:false,error:'Job lookup failed; retry pending.'},{status:500});
  let threadJobIds: string[] = [];
  if (threadMarker) {
    const {data,error} = await admin.from('job_contacts').select('job_id').eq('business_id',businessId).like('note',`%${threadMarker}%`);
    if (error) return NextResponse.json({ok:false,error:'Conversation lookup failed.'},{status:500});
    threadJobIds = [...new Set((data ?? []).map(c => c.job_id as string))];
  }
  const match = matchEmailJob(jobs ?? [],lead,{followUp,originalLink,threadJobIds});
  const saveContact = async (jobId:string) => {
    const contactId = emailLeadJobId(businessId,emailLeadMessageMarker(`contact:${identity ?? crypto.randomUUID()}`));
    const received = asString(body.received_at);
    const validDate = received && Number.isFinite(Date.parse(received)) && Date.parse(received) <= Date.now()+60000;
    const {error} = await admin.from('job_contacts').upsert({id:contactId,business_id:businessId,job_id:jobId,
      direction:'in',channel:'email',contacted_at:validDate ? received : new Date().toISOString(),
      note:[lead.notes,originalLink,marker,threadMarker].filter(Boolean).join('\n\n')},{onConflict:'id',ignoreDuplicates:true});
    return error;
  };
  if (match) {
    if (await saveContact(match)) return NextResponse.json({ok:false,error:'Conversation save failed.'},{status:500});
    return finish({ok:true,jobId:match,matched:true});
  }
  if (followUp) lead.notes += '\n\nFollow-up could not be linked confidently. Review and attach it to the correct job.';

  // ── 6. Insert the lead ──────────────────────────────────────────────────
  const { data: inserted, error: insertErr } = await admin
    .from('jobs')
    .insert({
      ...(stableJobId ? { id: stableJobId } : {}),
      business_id: businessId,
      name: lead.name,
      client_name: lead.clientName,
      client_email: lead.clientEmail ?? null,
      client_phone: lead.clientPhone ?? null,
      location: lead.location ?? null,
      status: 'lead',
      source: 'email',
      notes: [lead.notes, threadMarker, originalLink ? `Original email: ${originalLink}` : undefined, marker].filter(Boolean).join('\n\n'),
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    if (insertErr?.code === '23505' && stableJobId) {
      const { data: existing } = await admin.from('jobs').select('id')
        .eq('business_id', businessId).eq('id', stableJobId).maybeSingle();
      if (existing) {
        if (await saveContact(stableJobId)) return NextResponse.json({ok:false,error:'Contact retry failed.'},{status:500});
        return finish({ok:true,jobId:stableJobId,dedup:true});
      }
    }
    console.error('[inbound-email-lead] insert failed', insertErr);
    return NextResponse.json(
      { ok: false, error: 'Failed to create lead.', detail: insertErr?.message },
      { status: 500 },
    );
  }

  if (await saveContact(inserted.id as string)) return NextResponse.json({ok:false,error:'Contact save failed; retry pending.'},{status:500});

  // Instant push — same rationale as the Tapi webhook: forwarded
  // enquiries land silently, and speed-to-lead wins jobs. Fired before
  // the attachment pass (a slow upload shouldn't delay the buzz);
  // keyed on the job id so retries can't double-buzz. Best-effort.
  await sendBusinessNotificationSafe(admin, businessId, {
    ruleKey: 'lead-arrived',
    dedupeKey: inserted.id as string,
    title: 'New lead (email)',
    body: `${lead.name}${lead.clientName ? ` — ${lead.clientName}` : ''}`,
    url: '/leads',
  });

  // ── 7. Save any enquiry attachments (photos, plan PDFs) onto the lead ────
  // Best-effort: a storage/upload hiccup must never lose the lead we just
  // created, so this is wrapped and never throws upward.
  let attachments = { saved: 0, skipped: 0 };
  try {
    attachments = await saveLeadAttachments(
      admin,
      businessId,
      inserted.id as string,
      lead.location,
      body.attachments,
    );
  } catch (err) {
    console.error('[inbound-email-lead] saveLeadAttachments threw (lead kept)', err);
  }

  console.info('[inbound-email-lead] lead created', {
    jobId: inserted.id,
    name: lead.name,
    confidence,
    attachments,
  });
  return finish({ ok: true, jobId: inserted.id, name: lead.name, attachments });
}

/**
 * Minimal lead built without the LLM, for when the parser throws. Carries the
 * raw subject + a body snippet in notes so the enquiry is never lost — Brad
 * sees a "needs review" lead and can read the original email.
 */
function buildFallbackLead(input: {
  subject?: string;
  plain?: string;
  html?: string;
  fromHeader?: string;
}): EmailLeadFields {
  const snippetSource = input.plain ?? input.html ?? '';
  const snippet = snippetSource.replace(/\s+/g, ' ').trim().slice(0, 1500);
  const notesParts = [
    'Forwarded email lead — automatic parsing was unavailable, so this needs a quick manual check.',
  ];
  if (input.subject) notesParts.push(`\n\nEmail subject: ${input.subject}`);
  if (input.fromHeader) notesParts.push(`\nFrom: ${input.fromHeader}`);
  if (snippet) notesParts.push(`\n\n${snippet}`);
  return {
    name: input.subject ? `Email lead — ${input.subject}`.slice(0, 80) : 'Email lead — needs review',
    clientName: 'Email enquiry',
    notes: notesParts.join(''),
  };
}

// A browser GET should explain itself rather than 405 with no context.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'Use POST with x-webhook-secret header and a CloudMailin JSON payload.' },
    { status: 405 },
  );
}
