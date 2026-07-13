// POST /api/webhooks/inbound-email-lead
//
// Receives a forwarded customer enquiry from CloudMailin and creates a
// `lead`-status job in Trade Pilot with source='email'. This is for leads
// that DON'T come through the website contact form or Tapi — e.g. someone
// emails Lakeside directly, or Brad forwards on a referral. He forwards the
// email to this route's CloudMailin address and it lands in Jobs → Leads.
//
// Transport mirrors /api/webhooks/inbound-tapi-lead exactly (shared-secret
// auth, admin insert pinned to TRADEPILOT_BUSINESS_ID, content-based dedup).
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
//   4. Dedupe: skip if a matching email lead (same contact email, or same
//      name+location) was created in the last 7 days — catches retries /
//      double-forwards while letting a genuine re-enquiry weeks later through.
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
  normaliseForDedup,
  type EmailLeadFields,
} from '@/lib/email-lead-parser';
import { quoteToRow, quoteAttachmentToRow } from '@/lib/supabase/mappers';
import type { QuoteAttachmentKind } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Long enough to absorb provider retries / accidental re-forwards; short
// enough that a genuine re-enquiry about the same property weeks later still
// comes through as a fresh lead.
const DEDUP_WINDOW_DAYS = 7;

interface CloudMailinPayload {
  envelope?: { from?: unknown; to?: unknown };
  headers?: Record<string, unknown>;
  plain?: unknown;
  html?: unknown;
  subject?: unknown;
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
  const headerSecret = req.headers.get('x-webhook-secret');
  if (headerSecret && headerSecret === expectedSecret) return true;

  const basicHeader = req.headers.get('authorization');
  if (basicHeader?.toLowerCase().startsWith('basic ')) {
    const b64 = basicHeader.slice('basic '.length).trim();
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const user = decoded.slice(0, colonIdx);
        const pass = decoded.slice(colonIdx + 1);
        if (user === expectedSecret || pass === expectedSecret) return true;
      } else if (decoded === expectedSecret) {
        return true;
      }
    } catch {
      /* malformed base64 → not authenticated */
    }
  }
  return false;
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

  const headers = (body.headers && typeof body.headers === 'object')
    ? (body.headers as Record<string, unknown>)
    : {};
  const subject =
    asString(body.subject) ?? asString(headers['subject']) ?? asString(headers['Subject']);
  const plain = asString(body.plain);
  const html = asString(body.html);
  const fromHeader =
    asString(headers['from']) ?? asString(headers['From']) ?? asString(body.envelope?.from);

  if (!plain && !html && !subject) {
    return NextResponse.json(
      { ok: false, error: 'Empty email: need at least a subject or body.' },
      { status: 400 },
    );
  }

  // ── 4. LLM-parse → lead fields (never-drop fallback on failure) ──────────
  let lead: EmailLeadFields;
  let confidence: 'high' | 'medium' | 'low' = 'low';
  try {
    const parsed = await parseEmailLead({ subject, plain, html, from: fromHeader });

    // Confident not-a-lead → accept-and-ignore so a stray forward/newsletter
    // doesn't create junk. A 200 stops CloudMailin retrying.
    if (!parsed.looksLikeLead) {
      console.info('[inbound-email-lead] skipped — model judged not a lead', { subject, fromHeader });
      return NextResponse.json({ ok: true, skipped: true, reason: 'not-a-lead' });
    }

    confidence = parsed.confidence;
    lead = buildEmailLeadFields(parsed, { fromHeader, subject });
  } catch (err) {
    // Parser blew up (e.g. Anthropic outage). DO NOT drop the email — insert a
    // minimal lead carrying the raw content so Brad can action it by hand.
    console.error('[inbound-email-lead] parse failed; inserting fallback lead', err);
    lead = buildFallbackLead({ subject, plain, html, fromHeader });
  }

  // ── 5. Dedupe on content within the recent window ───────────────────────
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: dedupErr } = await admin
    .from('jobs')
    .select('id, name, location, client_email, created_at')
    .eq('business_id', businessId)
    .eq('source', 'email')
    .gte('created_at', windowStart);
  if (dedupErr) {
    // Don't block on a dedupe failure — better to risk a dupe than drop a lead.
    console.error('[inbound-email-lead] dedupe query failed', dedupErr);
  } else if (recent && recent.length > 0) {
    const incomingEmail = lead.clientEmail?.toLowerCase();
    const incomingKey = `${normaliseForDedup(lead.location)}|${normaliseForDedup(lead.name)}`;
    const dup = recent.find((r) => {
      const rowEmail = (r.client_email as string | null)?.toLowerCase();
      if (incomingEmail && rowEmail && rowEmail === incomingEmail) return true;
      const rowKey = `${normaliseForDedup(r.location as string | undefined)}|${normaliseForDedup(r.name as string | undefined)}`;
      return rowKey === incomingKey;
    });
    if (dup) {
      console.info('[inbound-email-lead] dedup hit', { jobId: dup.id, subject });
      return NextResponse.json({ ok: true, jobId: dup.id as string, dedup: true });
    }
  }

  // ── 6. Insert the lead ──────────────────────────────────────────────────
  const { data: inserted, error: insertErr } = await admin
    .from('jobs')
    .insert({
      business_id: businessId,
      name: lead.name,
      client_name: lead.clientName,
      client_email: lead.clientEmail ?? null,
      client_phone: lead.clientPhone ?? null,
      location: lead.location ?? null,
      status: 'lead',
      source: 'email',
      notes: lead.notes,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('[inbound-email-lead] insert failed', insertErr);
    return NextResponse.json(
      { ok: false, error: 'Failed to create lead.', detail: insertErr?.message },
      { status: 500 },
    );
  }

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
  return NextResponse.json({ ok: true, jobId: inserted.id, name: lead.name, attachments });
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
