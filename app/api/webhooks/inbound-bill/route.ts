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
import { parseBillText, MAX_BILL_TEXT_CHARS } from '@/lib/bill-parser';
import { extractPdfTextServer } from '@/lib/pdf/extract-text-server';
import { inferDueDate, type DueDateSource } from '@/lib/bill-due-date';
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

  // TEMP: log full payload so we can grab the Gmail forwarding-address
  // verification code/URL when adding bradleyjamesham@gmail.com as a
  // forwarding source. REMOVE once the One NZ filter is verified.
  console.log('CLOUDMAILIN_RAW_PAYLOAD:', JSON.stringify(body));

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

  // ── 5. Find the first PDF attachment ────────────────────────────────────
  const attachmentsRaw = Array.isArray(body.attachments) ? body.attachments : [];
  const pdfAttachment = attachmentsRaw
    .filter((a): a is CloudMailinAttachment => typeof a === 'object' && a !== null)
    .find((a) => {
      const ct = asString(a.content_type)?.toLowerCase();
      const fn = asString(a.file_name)?.toLowerCase();
      return ct === 'application/pdf' || (fn?.endsWith('.pdf') ?? false);
    });

  if (!pdfAttachment) {
    // Not all supplier emails carry a PDF (some are payment reminders,
    // statements, marketing). Accept and skip — don't 4xx because that
    // would cause CloudMailin to retry indefinitely.
    console.info('[inbound-bill] no PDF attachment; skipping', { messageId, subject, fromAddress });
    return NextResponse.json({ ok: true, skipped: true, reason: 'no PDF attachment' });
  }

  const base64 = asString(pdfAttachment.content);
  if (!base64) {
    return NextResponse.json(
      { ok: false, error: 'PDF attachment missing content.' },
      { status: 400 },
    );
  }

  // Decode the base64 attachment into a Buffer. Size guard — corporate
  // invoices are tiny; anything >10MB is almost certainly malformed.
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = Buffer.from(base64, 'base64');
  } catch (err) {
    console.error('[inbound-bill] base64 decode failed:', err);
    return NextResponse.json(
      { ok: false, error: 'Could not decode PDF attachment.' },
      { status: 400 },
    );
  }
  if (pdfBuffer.length === 0 || pdfBuffer.length > MAX_PDF_BYTES) {
    return NextResponse.json(
      { ok: false, error: `PDF size out of range (${pdfBuffer.length} bytes).` },
      { status: 400 },
    );
  }

  // ── 6. Extract text + parse via shared library ──────────────────────────
  let pdfText: string;
  try {
    const extracted = await extractPdfTextServer(pdfBuffer);
    pdfText = extracted.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[inbound-bill] PDF text extract failed:', msg);
    return NextResponse.json(
      { ok: false, error: 'Could not extract text from PDF.', detail: msg },
      { status: 502 },
    );
  }
  if (pdfText.trim().length < 20) {
    console.warn('[inbound-bill] PDF has no readable text (likely image-only scan)', { messageId });
    return NextResponse.json(
      { ok: true, skipped: true, reason: 'PDF has no readable text layer (likely image-only scan).' },
    );
  }
  if (pdfText.length > MAX_BILL_TEXT_CHARS) {
    pdfText = pdfText.slice(0, MAX_BILL_TEXT_CHARS);
  }

  let parsed: ParsedBill;
  try {
    parsed = await parseBillText(pdfText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[inbound-bill] parseBillText failed:', msg);
    return NextResponse.json(
      { ok: false, error: 'Upstream parser error.', detail: msg },
      { status: 502 },
    );
  }

  // ── 7. Upload PDF to Storage ────────────────────────────────────────────
  // Best-effort. If this fails we still create the draft — Brad can
  // re-attach later. The parsed fields are the high-value bit.
  const uuid = crypto.randomUUID();
  const objectPath = `${businessId}/${uuid}.pdf`;
  let billPdfUrl: string | undefined;
  try {
    const { error: uploadErr } = await admin.storage
      .from('bill-pdfs')
      .upload(objectPath, pdfBuffer, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: false,
      });
    if (uploadErr) {
      console.warn('[inbound-bill] Storage upload failed; continuing without PDF:', uploadErr);
    } else {
      billPdfUrl = objectPath;
    }
  } catch (err) {
    console.warn('[inbound-bill] Storage upload threw:', err);
  }

  // ── 8. Job-guess via rankJobs ───────────────────────────────────────────
  let guessedJobId: string | undefined;
  if (parsed.jobHint) {
    // Need the jobs list for fuzzy matching. Single business so this is
    // cheap. Use rowToJob for camelCase translation.
    const { data: jobRows, error: jobsErr } = await admin
      .from('jobs')
      .select('*')
      .eq('business_id', businessId);
    if (!jobsErr && jobRows) {
      const jobs: Job[] = jobRows.map(rowToJob);
      const ranked = rankJobs(jobs, parsed.jobHint);
      const top = ranked[0];
      if (top && top.tier === 'active-match' && top.score >= JOB_MATCH_MIN_SCORE) {
        guessedJobId = top.job.id;
      }
    }
  }

  // ── 9. Resolve due date ────────────────────────────────────────────────
  let resolvedDueDate: string | undefined;
  let dueDateSource: DueDateSource | undefined;
  if (parsed.dueDate) {
    resolvedDueDate = parsed.dueDate;
    dueDateSource = 'pdf';
  } else if (parsed.invoiceDate) {
    const inferred = inferDueDate(parsed.invoiceDate);
    if (inferred) {
      resolvedDueDate = inferred;
      dueDateSource = 'computed';
    }
  }

  // ── 10. Build + insert the draft entry ─────────────────────────────────
  const todayISO = new Date().toISOString().slice(0, 10);
  const draftInit: Omit<Entry, 'id' | 'createdAt'> = {
    businessId,
    jobId: guessedJobId,
    type: 'bill',
    isDraft: true,
    billPdfUrl,
    parserConfidence: parsed.confidence,
    parserRaw: { ...parsed, dueDateSource },
    sourceMessageId: messageId,
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
  // entryToRow strips businessId — we need to put it back on the row for
  // the insert. (It's not stripped per se, but the mapper assumes the
  // store has already set business_id by other means.)
  row.business_id = businessId;
  // The entries table requires created_at; default is set by the DB but
  // for clarity stamp it explicitly so the order is deterministic.
  row.created_at = new Date().toISOString();

  const { data: inserted, error: insertErr } = await admin
    .from('entries')
    .insert(row)
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('[inbound-bill] entry insert failed:', insertErr);
    // Best-effort: delete the uploaded PDF so we don't leave an orphan.
    if (billPdfUrl) {
      void admin.storage.from('bill-pdfs').remove([billPdfUrl]).catch(() => {});
    }
    return NextResponse.json(
      { ok: false, error: 'Failed to save draft.', detail: insertErr?.message },
      { status: 503 },
    );
  }

  console.info('[inbound-bill] draft created', {
    entryId: inserted.id,
    supplier: parsed.supplier,
    total: parsed.totalInclGst,
    pdfStored: Boolean(billPdfUrl),
    jobGuessed: Boolean(guessedJobId),
  });

  return NextResponse.json({
    ok: true,
    entryId: inserted.id,
    supplier: parsed.supplier,
    total: parsed.totalInclGst,
    pdfStored: Boolean(billPdfUrl),
    jobGuessed: Boolean(guessedJobId),
  });
}

/** Same human-readable description fallback as the upload card. */
function buildDescription(p: ParsedBill): string {
  const parts: string[] = [];
  if (p.supplier) parts.push(p.supplier);
  if (p.invoiceNumber) parts.push(`#${p.invoiceNumber}`);
  if (parts.length === 0) parts.push('Bill');
  return parts.join(' ');
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'Use POST with x-webhook-secret header and CloudMailin JSON payload.' },
    { status: 405 },
  );
}
