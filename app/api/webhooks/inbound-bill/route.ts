// POST /api/webhooks/inbound-bill
//
// Receives forwarded supplier emails from CloudMailin (or any compatible
// inbound-mail provider) and turns them into draft bills on Home.
//
// Pipeline:
//   1. Auth via x-webhook-secret (shared secret in env).
//   2. Parse the CloudMailin JSON payload.
//   3. Idempotency: look up the email's Message-ID. If we've already
//      drafted from it, return 200 + {dedup: true} without doing any
//      work. Stops retry storms from creating duplicates.
//   4. Locate the first PDF attachment. If none, return 200 with a
//      skipped:true note — we accept the email but don't try to draft
//      anything (e.g. text-only payment reminders).
//   5. Decode the base64 attachment, extract text server-side via
//      pdf-parse, run the shared parseBillText() pipeline.
//   6. Upload original PDF to bill-pdfs bucket at
//      {businessId}/{uuid}.pdf. Continue without PDF if upload fails —
//      parsed fields are still valuable.
//   7. rankJobs() against parser jobHint; pre-fill jobId only if score
//      is above the auto-allocate threshold (matches manual-upload card).
//   8. Resolve due date — prefer PDF value, fall back to NZ "20th of
//      following month" rule via inferDueDate().
//   9. Insert draft entry via admin client (this runs server-side with
//      no user session, so the admin client is the right tool).
//
// We use the admin client (service role) here because:
//   - There's no auth.uid() for an inbound webhook caller
//   - RLS on entries requires owner_id-of-business = auth.uid()
//   - The TRADEPILOT_BUSINESS_ID env var pins which business inbound
//     bills are added to (same as the website-enquiry webhook)
//
// Returns:
//   200 { ok: true, entryId, dedup?: true, skipped?: true }
//   400 invalid payload
//   401 missing/invalid shared secret
//   500 server config (env vars missing)
//   502 upstream parser error
//   503 storage / DB error

import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { parseBillText, parseBillImage, MAX_BILL_TEXT_CHARS, MAX_BILL_VISION_BYTES } from '@/lib/bill-parser';
import { findMatchingBillIndex } from '@/lib/bill-dedupe';
import { extractPdfTextServer } from '@/lib/pdf/extract-text-server';
import { inferDueDate, type DueDateSource } from '@/lib/bill-due-date';
import { followBillDownloadLink, type LinkFollowResult } from '@/lib/bill-link-follower';
import { rankJobs } from '@/lib/job-match';
import { rowToJob, entryToRow } from '@/lib/supabase/mappers';
import type { Entry, Job, ParsedBill } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Match the manual-upload card's threshold so the auto-allocate behaviour
// is identical between manual and webhook paths.
const JOB_MATCH_MIN_SCORE = 10;
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB sanity cap

// CloudMailin v0.4 attachment shape (which is what the inbound-mail JSON
// format uses). We narrow defensively because email payloads are sent
// from an external service we don't fully trust.
interface CloudMailinAttachment {
  file_name?: unknown;
  content_type?: unknown;
  content?: unknown; // base64-encoded
  size?: unknown;
}

interface CloudMailinPayload {
  envelope?: { from?: unknown; to?: unknown };
  headers?: Record<string, unknown>;
  plain?: unknown;
  html?: unknown;
  attachments?: unknown;
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

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function POST(req: Request) {
  // ── 1. Authenticate via shared secret ───────────────────────────────────
  // We accept the secret two ways so the route works with email-receiver
  // providers that have different auth conventions:
  //   (a) `x-webhook-secret: <secret>` header — used by Postmark, our
  //       smoke-test script, and CloudMailin paid plans.
  //   (b) Basic auth in the URL — used by CloudMailin free tier (custom
  //       headers aren't allowed on that plan). The URL looks like
  //       `https://anything:<secret>@host/...` and Node decodes it into
  //       an `Authorization: Basic base64(anything:<secret>)` header.
  //       We match either the username or password against the secret so
  //       the user can pick whichever URL shape is cleaner.
  const expectedSecret = process.env.INBOUND_BILL_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: INBOUND_BILL_WEBHOOK_SECRET not set.' },
      { status: 500 },
    );
  }

  let authenticated = false;
  const headerSecret = req.headers.get('x-webhook-secret');
  if (headerSecret && headerSecret === expectedSecret) {
    authenticated = true;
  }
  if (!authenticated) {
    const basicHeader = req.headers.get('authorization');
    if (basicHeader?.toLowerCase().startsWith('basic ')) {
      const b64 = basicHeader.slice('basic '.length).trim();
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        const colonIdx = decoded.indexOf(':');
        if (colonIdx !== -1) {
          const user = decoded.slice(0, colonIdx);
          const pass = decoded.slice(colonIdx + 1);
          if (user === expectedSecret || pass === expectedSecret) {
            authenticated = true;
          }
        } else if (decoded === expectedSecret) {
          // Some clients omit the colon entirely.
          authenticated = true;
        }
      } catch {
        // Malformed base64 — fall through to 401.
      }
    }
  }

  if (!authenticated) {
    return NextResponse.json(
      { ok: false, error: 'Invalid or missing webhook secret.' },
      { status: 401 },
    );
  }

  // ── 2. Resolve business id ──────────────────────────────────────────────
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

  // ── 3. Parse + validate body ────────────────────────────────────────────
  let body: CloudMailinPayload;
  try {
    body = (await req.json()) as CloudMailinPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }

  // CloudMailin lowercases header keys. Tolerate either case anyway.
  const headers = (body.headers && typeof body.headers === 'object')
    ? body.headers as Record<string, unknown>
    : {};
  const messageId = asString(headers['message_id'])
    ?? asString(headers['Message-ID'])
    ?? asString(headers['message-id']);
  const subject = asString(headers['subject']) ?? asString(headers['Subject']);
  const fromAddress = asString(body.envelope?.from)
    ?? asString(headers['from'])
    ?? asString(headers['From']);

  if (!messageId) {
    return NextResponse.json(
      { ok: false, error: 'Missing Message-ID header — cannot dedupe.' },
      { status: 400 },
    );
  }

  // ── 4. Dedupe by Message-ID ─────────────────────────────────────────────
  // Unique index on (business_id, source_message_id) makes this a single
  // round trip. A second delivery of the same email returns dedup:true.
  const { data: existing, error: dedupErr } = await admin
    .from('entries')
    .select('id')
    .eq('business_id', businessId)
    .eq('source_message_id', messageId)
    .limit(1)
    .maybeSingle();
  if (dedupErr) {
    console.error('[inbound-bill] dedupe query failed:', dedupErr);
    // Don't fail — better to risk a dupe than drop a real bill.
  }
  if (existing) {
    console.info('[inbound-bill] dedup hit', { messageId, entryId: existing.id });
    return NextResponse.json({ ok: true, entryId: existing.id, dedup: true });
  }

  // ── 5. Collect EVERY PDF on the email ───────────────────────────────────
  //
  // Supplier emails increasingly bundle several invoices as separate PDF
  // attachments — Dulux sends one PDF per invoice. We process every PDF so
  // each invoice becomes its own bill (the old code only took the first,
  // which is why the Dulux siblings went missing). If there are no
  // attachments we fall back to the link-follower (Dulux's link-style
  // emails), which yields a single PDF. If neither produces a PDF we record
  // a "needs attention" draft so the email never disappears silently.
  const attachmentsRaw = Array.isArray(body.attachments) ? body.attachments : [];
  const pdfBuffers: Buffer[] = [];
  for (const a of attachmentsRaw) {
    if (typeof a !== 'object' || a === null) continue;
    const att = a as CloudMailinAttachment;
    const ct = asString(att.content_type)?.toLowerCase();
    const fn = asString(att.file_name)?.toLowerCase();
    const isPdf = ct === 'application/pdf' || (fn?.endsWith('.pdf') ?? false);
    if (!isPdf) continue;
    const base64 = asString(att.content);
    if (!base64) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      continue;
    }
    if (buf.length === 0 || buf.length > MAX_PDF_BYTES) {
      console.warn('[inbound-bill] skipping PDF attachment out of size range', { bytes: buf.length, fn });
      continue;
    }
    pdfBuffers.push(buf);
  }

  let pdfSource: 'attachment' | 'link' = 'attachment';
  let linkFollowResult: LinkFollowResult | undefined;
  if (pdfBuffers.length === 0) {
    linkFollowResult = await followBillDownloadLink({
      plain: asString(body.plain),
      html: asString(body.html),
    });
    if (linkFollowResult.pdf) {
      pdfBuffers.push(linkFollowResult.pdf);
      pdfSource = 'link';
      console.info('[inbound-bill] fetched PDF via download link', {
        messageId, finalUrl: linkFollowResult.finalUrl, bytes: linkFollowResult.pdf.length,
      });
    }
  }

  // No PDF at all → record a "needs attention" placeholder draft and return.
  if (pdfBuffers.length === 0) {
    return insertFailureDraft(admin, {
      businessId,
      messageId,
      subject,
      fromAddress,
      failureReason: linkFollowResult?.reason ?? 'no-pdf-attachment',
      failureDetail: linkFollowResult?.detail
        ?? 'Email had no PDF attachment and no allowlisted download link.',
    });
  }

  // Fetch jobs once for fuzzy job-matching across all the PDFs.
  let jobsCache: Job[] = [];
  {
    const { data: jobRows } = await admin.from('jobs').select('*').eq('business_id', businessId);
    if (jobRows) jobsCache = jobRows.map(rowToJob);
  }

  // Fetch existing bills once for create-or-merge matching, so re-forwarding
  // (or overlap with a backfilled amount-only stub) enriches the existing
  // bill rather than duplicating it.
  let existingBills: ExistingBillRow[] = [];
  {
    const { data: billRows } = await admin
      .from('entries')
      .select('id, payment_ref, amount, supplier, company, parser_raw, bill_pdf_url, source_message_id')
      .eq('business_id', businessId)
      .eq('type', 'bill');
    if (billRows) existingBills = billRows as ExistingBillRow[];
  }

  // ── 6. Process each PDF → create-or-merge a bill ────────────────────────
  const created: string[] = [];
  const merged: string[] = [];
  const failures: { reason: string; detail: string }[] = [];

  for (let i = 0; i < pdfBuffers.length; i++) {
    const r = await processOnePdf(admin, pdfBuffers[i], {
      businessId,
      messageId,
      index: i,
      pdfSource,
      linkFollowFinalUrl: linkFollowResult?.finalUrl,
      jobs: jobsCache,
      existingBills,
    });
    if (r.status === 'created') created.push(r.entryId);
    else if (r.status === 'merged') merged.push(r.entryId);
    else failures.push({ reason: r.reason, detail: r.detail });
  }

  // If EVERY PDF failed to parse, don't drop the email silently — record a
  // "needs attention" draft (using the first failure's reason).
  if (created.length === 0 && merged.length === 0 && failures.length > 0) {
    return insertFailureDraft(admin, {
      businessId,
      messageId,
      subject,
      fromAddress,
      failureReason: failures[0].reason,
      failureDetail: failures[0].detail,
      pdfSource,
    });
  }

  console.info('[inbound-bill] processed email', {
    messageId,
    pdfs: pdfBuffers.length,
    created: created.length,
    merged: merged.length,
    failed: failures.length,
  });
  return NextResponse.json({
    ok: true,
    created: created.length,
    merged: merged.length,
    failed: failures.length,
    entryIds: [...created, ...merged],
  });
}

// ── Process one PDF: parse (text or vision) → create-or-merge a bill ──────
interface ExistingBillRow {
  id: string;
  payment_ref: string | null;
  amount: number | null;
  supplier: string | null;
  company: string | null;
  parser_raw: unknown;
  bill_pdf_url: string | null;
  source_message_id: string | null;
}
interface ProcessCtx {
  businessId: string;
  messageId: string;
  index: number;
  pdfSource: 'attachment' | 'link';
  linkFollowFinalUrl?: string;
  jobs: Job[];
  existingBills: ExistingBillRow[];
}
type ProcessResult =
  | { status: 'created'; entryId: string }
  | { status: 'merged'; entryId: string }
  | { status: 'failed'; reason: string; detail: string };

async function processOnePdf(
  admin: SupabaseClient,
  pdfBuffer: Buffer,
  ctx: ProcessCtx,
): Promise<ProcessResult> {
  const { businessId, messageId, index, pdfSource, linkFollowFinalUrl, jobs, existingBills } = ctx;

  // Parse: extract the text layer first (fast + exact); for image-only /
  // scanned PDFs with no text, vision-read the PDF instead.
  let parsed: ParsedBill;
  try {
    let text = '';
    try {
      text = (await extractPdfTextServer(pdfBuffer)).text;
    } catch (err) {
      console.warn('[inbound-bill] text extract failed; trying vision', err);
    }
    if (text.trim().length >= 20) {
      if (text.length > MAX_BILL_TEXT_CHARS) text = text.slice(0, MAX_BILL_TEXT_CHARS);
      parsed = await parseBillText(text);
    } else {
      if (pdfBuffer.length > MAX_BILL_VISION_BYTES) {
        return { status: 'failed', reason: 'image-only-pdf', detail: 'Scanned PDF too large to vision-read.' };
      }
      parsed = await parseBillImage(pdfBuffer.toString('base64'), 'application/pdf');
    }
  } catch (err) {
    return { status: 'failed', reason: 'parser-error', detail: err instanceof Error ? err.message : String(err) };
  }

  // Upload this PDF (best-effort — the parsed fields are the high-value bit).
  let billPdfUrl: string | undefined;
  try {
    const objectPath = `${businessId}/${crypto.randomUUID()}.pdf`;
    const { error } = await admin.storage.from('bill-pdfs').upload(objectPath, pdfBuffer, {
      contentType: 'application/pdf', cacheControl: '3600', upsert: false,
    });
    if (!error) billPdfUrl = objectPath;
  } catch {
    /* best-effort */
  }

  // Job-guess from the parser's hint.
  let guessedJobId: string | undefined;
  if (parsed.jobHint && jobs.length > 0) {
    const top = rankJobs(jobs, parsed.jobHint)[0];
    if (top && top.tier === 'active-match' && top.score >= JOB_MATCH_MIN_SCORE) guessedJobId = top.job.id;
  }

  // Per-invoice source id: several invoices from one email must not collide
  // on the unique (business_id, source_message_id) index, and re-forwarding
  // the same email stays idempotent.
  const sourceId = `${messageId}#${parsed.invoiceNumber ?? `idx${index}`}`;

  // Create-or-merge: match against bills already in the system (pre-fetched).
  // First by the per-invoice source id (idempotent re-forward), then by
  // normalized invoice number / identical amount + supplier — which catches a
  // backfilled amount-only stub whose invoice number is formatted differently
  // (e.g. 0909019353 vs 909019353).
  let existing: ExistingBillRow | null =
    existingBills.find((b) => b.source_message_id === sourceId) ?? null;
  if (!existing) {
    const idx = findMatchingBillIndex(
      existingBills.map((b) => ({ invoiceNumber: b.payment_ref, amount: b.amount, supplier: b.supplier, company: b.company })),
      { invoiceNumber: parsed.invoiceNumber, totalInclGst: parsed.totalInclGst, supplier: parsed.supplier },
    );
    if (idx !== -1) existing = existingBills[idx];
  }

  if (existing) {
    // Merge line items + attach the doc; never overwrite the trusted amount.
    const existingRaw = (existing.parser_raw && typeof existing.parser_raw === 'object')
      ? existing.parser_raw as Record<string, unknown> : {};
    const mergedRaw: Record<string, unknown> = { ...existingRaw };
    if (parsed.lineItems && parsed.lineItems.length > 0) mergedRaw.lineItems = parsed.lineItems;
    const patch: Record<string, unknown> = { parser_raw: mergedRaw };
    if (!existing.bill_pdf_url && billPdfUrl) patch.bill_pdf_url = billPdfUrl;
    const { error } = await admin.from('entries').update(patch).eq('id', existing.id);
    if (error) return { status: 'failed', reason: 'merge-failed', detail: error.message };
    return { status: 'merged', entryId: existing.id };
  }

  // Insert a new draft.
  let resolvedDueDate: string | undefined;
  let dueDateSource: DueDateSource | undefined;
  if (parsed.dueDate) { resolvedDueDate = parsed.dueDate; dueDateSource = 'pdf'; }
  else if (parsed.invoiceDate) {
    const inferred = inferDueDate(parsed.invoiceDate);
    if (inferred) { resolvedDueDate = inferred; dueDateSource = 'computed'; }
  }
  const todayISO = new Date().toISOString().slice(0, 10);
  const draftInit: Omit<Entry, 'id' | 'createdAt'> = {
    businessId,
    jobId: guessedJobId,
    type: 'bill',
    isDraft: true,
    billPdfUrl,
    parserConfidence: parsed.confidence,
    parserRaw: { ...parsed, dueDateSource, pdfSource, linkFollowFinalUrl },
    sourceMessageId: sourceId,
    company: parsed.supplier,
    supplier: parsed.supplier,
    description: buildDescription(parsed),
    amount: parsed.totalInclGst,
    amountExGst: parsed.amountExGst,
    gstComponent: parsed.gstComponent,
    gstApplies: true,
    paid: false,
    entryDate: parsed.invoiceDate ?? todayISO,
    dueDate: resolvedDueDate,
    paymentRef: parsed.invoiceNumber,
  };
  const row = entryToRow(draftInit);
  row.business_id = businessId;
  row.created_at = new Date().toISOString();
  const { data: inserted, error: insertErr } = await admin
    .from('entries').insert(row).select('id').single();
  if (insertErr || !inserted) {
    // Unique-index race on the same source id → already recorded; treat as merged.
    if (insertErr?.code === '23505') return { status: 'merged', entryId: 'dedup' };
    if (billPdfUrl) void admin.storage.from('bill-pdfs').remove([billPdfUrl]).catch(() => {});
    return { status: 'failed', reason: 'insert-failed', detail: insertErr?.message ?? 'unknown' };
  }
  return { status: 'created', entryId: inserted.id };
}

/** Same human-readable description fallback as the upload card. */
function buildDescription(p: ParsedBill): string {
  const parts: string[] = [];
  if (p.supplier) parts.push(p.supplier);
  if (p.invoiceNumber) parts.push(`#${p.invoiceNumber}`);
  if (parts.length === 0) parts.push('Bill');
  return parts.join(' ');
}

/**
 * Failure-draft path. Inserted when an email arrived but we couldn't
 * extract a usable bill from it (no PDF, image-only scan, parser error,
 * etc.). Lands on Home as a draft so the user sees "this email needs
 * attention" instead of the email silently disappearing — that silent
 * drop was the bug that masked the Dulux link-style switchover for days.
 *
 * Shape: a draft `bill` entry with no amount/supplier set, a description
 * that names the sender + subject, and a `parser_raw.failure` payload
 * the Home UI can read to show a distinct "couldn't parse" row.
 *
 * Always returns 200. CloudMailin would retry 5xx indefinitely, which
 * would be the wrong reaction here — the email is real but unparseable;
 * the human needs to act.
 */
interface FailureContext {
  businessId: string;
  messageId: string;
  subject?: string;
  fromAddress?: string;
  failureReason: string;
  failureDetail: string;
  /** 'attachment' if we got the bytes from the email, 'link' if from a
   *  download URL; omitted when no PDF was located at all. */
  pdfSource?: 'attachment' | 'link';
}

async function insertFailureDraft(
  admin: SupabaseClient,
  ctx: FailureContext,
): Promise<NextResponse> {
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);

  // Best-effort sender label for the description. Strip the angle-
  // brackets around the bare email part if present ("Foo <a@b>").
  const senderLabel = ctx.fromAddress
    ? ctx.fromAddress.replace(/^.*<([^>]+)>.*$/, '$1')
    : 'unknown sender';
  const subjectLabel = ctx.subject ?? '(no subject)';

  const draftInit: Omit<Entry, 'id' | 'createdAt'> = {
    businessId: ctx.businessId,
    type: 'bill',
    isDraft: true,
    parserConfidence: 'low',
    parserRaw: {
      failure: {
        reason: ctx.failureReason,
        detail: ctx.failureDetail,
        pdfSource: ctx.pdfSource,
        subject: ctx.subject,
        fromAddress: ctx.fromAddress,
        receivedAt: now.toISOString(),
      },
    },
    sourceMessageId: ctx.messageId,
    company: senderLabel,
    supplier: senderLabel,
    description: `Couldn't parse: ${subjectLabel}`,
    gstApplies: true,
    paid: false,
    entryDate: todayISO,
  };

  const row = entryToRow(draftInit);
  row.business_id = ctx.businessId;
  row.created_at = now.toISOString();

  const { data: inserted, error: insertErr } = await admin
    .from('entries')
    .insert(row)
    .select('id')
    .single();

  if (insertErr || !inserted) {
    // Unique-index conflict on (business_id, source_message_id) means
    // we already recorded this failure — treat as success-with-dedup.
    if (insertErr?.code === '23505') {
      console.info('[inbound-bill] failure-draft dedup hit', { messageId: ctx.messageId });
      return NextResponse.json({ ok: true, dedup: true, failure: ctx.failureReason });
    }
    console.error('[inbound-bill] failure-draft insert failed:', insertErr);
    return NextResponse.json(
      { ok: false, error: 'Failed to save failure draft.', detail: insertErr?.message },
      { status: 503 },
    );
  }

  console.info('[inbound-bill] failure draft created', {
    entryId: inserted.id,
    reason: ctx.failureReason,
    detail: ctx.failureDetail,
    sender: senderLabel,
    subject: ctx.subject,
  });

  return NextResponse.json({
    ok: true,
    entryId: inserted.id,
    failure: ctx.failureReason,
    detail: ctx.failureDetail,
  });
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'Use POST with x-webhook-secret header and CloudMailin JSON payload.' },
    { status: 405 },
  );
}
