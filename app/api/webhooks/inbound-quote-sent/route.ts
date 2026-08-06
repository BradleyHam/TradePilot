// POST /api/webhooks/inbound-quote-sent
//
// Receives a quote email BRAD SENT (forwarded by the Apps Script sent-mail
// poller — scripts/apps-script-quote-sent-forwarder.gs) and does everything
// the Mark-as-quoted sheet does, automatically:
//
//   - matches the email to an open lead (recipient email → address → name)
//   - parses the quote PDF (lib/quote-parser.ts, Haiku) for the total + scope
//   - writes/updates the quote row (total incl-GST, date sent, status='sent')
//   - attaches the quote PDF to the job (quote-attachments, kind='quote_pdf')
//   - flips the job to 'quoted' with quote_amount EX-GST, follow-up date +5d
//   - logs a 'quote-sent' contact + bumps last_contacted_date
//
// No matching lead? Creates the job as 'quoted' (Brad's call — the lead
// obviously exists in real life, it just never made it into the app).
//
// PRECISION over recall — the opposite bias to inbound-email-lead. A missed
// email costs Brad one tap on the "Sent the quote" button; a false positive
// silently corrupts pipeline + win-rate data. So:
//   - no status flip without either a parsed total or a recipient-email match
//   - never regresses a job past 'quoted' (accepted/booked jobs are left alone)
//   - auto-create only when the parse found a total AND a client/address
//
// Transport is the Resene-forwarder pattern: the Apps Script POSTs a
// CloudMailin-shaped payload directly (no CloudMailin account involved),
// authenticated with QUOTE_SENT_WEBHOOK_SECRET via lib/webhook-auth.ts.

import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { parseQuoteText, MAX_QUOTE_TEXT_CHARS } from '@/lib/quote-parser';
import { extractPdfTextServer } from '@/lib/pdf/extract-text-server';
import { normaliseForDedup } from '@/lib/email-lead-parser';
import { quoteToRow, quoteAttachmentToRow } from '@/lib/supabase/mappers';
import { webhookRequestAuthenticated } from '@/lib/webhook-auth';
import type { ParsedQuote } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NZ_GST_RATE = 0.15;
const FOLLOW_UP_DAYS = 5; // same default as MarkAsQuotedSheet
const MAX_PDF_BYTES = 25 * 1024 * 1024;
// A re-send of the same quote to the same job within this window is a retry /
// "resending in case you missed it", not a new quote.
const DEDUP_TOLERANCE_DOLLARS = 0.02;

interface InboundPayload {
  envelope?: { from?: unknown; to?: unknown };
  headers?: Record<string, unknown>;
  plain?: unknown;
  html?: unknown;
  subject?: unknown;
  /** ISO timestamp the email was sent (Apps Script adds this). */
  sent_at?: unknown;
  attachments?: unknown;
}

interface InboundAttachment {
  file_name?: unknown;
  content_type?: unknown;
  content?: unknown; // base64
}

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function getAdminClient(): SupabaseClient | { error: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { error: 'Server misconfigured: Supabase env vars missing.' };
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Every email address found in a To/CC-style header string, lowercased. */
function extractEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  const matches = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

/** ISO date +N days, TZ-safe. */
function addDaysISO(iso: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Pick the quote PDF: prefer a filename containing "quote", else first PDF. */
function pickQuotePdf(rawAttachments: unknown): { buf: Buffer; fileName: string } | null {
  const list = Array.isArray(rawAttachments) ? rawAttachments : [];
  const pdfs: { buf: Buffer; fileName: string }[] = [];
  for (const a of list) {
    if (typeof a !== 'object' || a === null) continue;
    const att = a as InboundAttachment;
    const fn = asString(att.file_name) ?? '';
    const ct = asString(att.content_type)?.toLowerCase() ?? '';
    const isPdf = ct === 'application/pdf' || fn.toLowerCase().endsWith('.pdf');
    if (!isPdf) continue;
    const base64 = asString(att.content);
    if (!base64) continue;
    let buf: Buffer;
    try { buf = Buffer.from(base64, 'base64'); } catch { continue; }
    if (buf.length === 0 || buf.length > MAX_PDF_BYTES) continue;
    pdfs.push({ buf, fileName: fn || 'quote.pdf' });
  }
  if (pdfs.length === 0) return null;
  return pdfs.find((p) => p.fileName.toLowerCase().includes('quote')) ?? pdfs[0];
}

type MatchBasis = 'client-email' | 'address' | 'client-name';

interface OpenJobRow {
  id: string;
  name: string | null;
  status: string;
  client_name: string | null;
  client_email: string | null;
  location: string | null;
}

/**
 * Match the sent quote to an open lead/quoted job. Tiered, most reliable
 * first. Address/name tiers use the same normalisation as the email-lead
 * dedupe so "3 Hidden Hills Drive, Wanaka" matches "3 hidden hills drive".
 */
function matchJob(
  jobs: OpenJobRow[],
  recipients: string[],
  parsed: ParsedQuote | null,
): { job: OpenJobRow; basis: MatchBasis } | null {
  // Tier 1 — recipient email equals the lead's client email.
  for (const j of jobs) {
    const je = j.client_email?.toLowerCase();
    if (je && recipients.includes(je)) return { job: j, basis: 'client-email' };
  }
  if (!parsed) return null;

  // Tier 2 — parsed job address vs the lead's location/name (containment
  // either way — quotes often carry the full address, the app a short one).
  const addr = normaliseForDedup(parsed.jobAddress);
  if (addr && addr.length >= 6) {
    for (const j of jobs) {
      const loc = normaliseForDedup(j.location ?? undefined);
      const nm = normaliseForDedup(j.name ?? undefined);
      if (loc && (loc.includes(addr) || addr.includes(loc))) return { job: j, basis: 'address' };
      if (nm && (nm.includes(addr) || addr.includes(nm))) return { job: j, basis: 'address' };
    }
  }

  // Tier 3 — parsed client name vs the lead's client name (exact after
  // normalisation only — fuzzy name matching is how wrong jobs get flipped).
  const client = normaliseForDedup(parsed.clientName);
  if (client && client.length >= 4) {
    for (const j of jobs) {
      if (normaliseForDedup(j.client_name ?? undefined) === client) {
        return { job: j, basis: 'client-name' };
      }
    }
  }
  return null;
}

/** Upload the quote PDF + insert its attachment row. Best-effort, never throws. */
async function attachQuotePdf(
  admin: SupabaseClient,
  businessId: string,
  quoteId: string,
  pdf: { buf: Buffer; fileName: string },
): Promise<boolean> {
  try {
    const safeName = pdf.fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const storagePath = `${businessId}/${quoteId}/${crypto.randomUUID()}__${safeName}`;
    const { error: upErr } = await admin.storage
      .from('quote-attachments')
      .upload(storagePath, pdf.buf, { contentType: 'application/pdf', upsert: false });
    if (upErr) {
      console.error('[inbound-quote-sent] PDF upload failed', upErr);
      return false;
    }
    const { error: insErr } = await admin
      .from('quote_attachments')
      .insert(quoteAttachmentToRow({
        businessId, quoteId, kind: 'quote_pdf', storagePath, fileName: pdf.fileName,
      }));
    if (insErr) {
      console.error('[inbound-quote-sent] attachment row insert failed', insErr);
      await admin.storage.from('quote-attachments').remove([storagePath]).catch(() => {});
      return false;
    }
    return true;
  } catch (err) {
    console.error('[inbound-quote-sent] attachQuotePdf threw', err);
    return false;
  }
}

export async function POST(req: Request) {
  // ── 1. Authenticate ─────────────────────────────────────────────────────
  const expectedSecret = process.env.QUOTE_SENT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: QUOTE_SENT_WEBHOOK_SECRET not set.' },
      { status: 500 },
    );
  }
  if (!webhookRequestAuthenticated(req, expectedSecret)) {
    return NextResponse.json({ ok: false, error: 'Invalid or missing webhook secret.' }, { status: 401 });
  }

  // ── 2. Env + admin client ───────────────────────────────────────────────
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

  // ── 3. Parse payload ────────────────────────────────────────────────────
  let body: InboundPayload;
  try {
    body = (await req.json()) as InboundPayload;
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const headers = (body.headers && typeof body.headers === 'object')
    ? (body.headers as Record<string, unknown>)
    : {};
  const subject = asString(body.subject) ?? asString(headers['subject']) ?? asString(headers['Subject']);
  const plain = asString(body.plain);
  const toHeader = asString(headers['to']) ?? asString(headers['To']) ?? asString(body.envelope?.to);
  const ccHeader = asString(headers['cc']) ?? asString(headers['Cc']);
  const recipients = [...extractEmails(toHeader), ...extractEmails(ccHeader)]
    // Never match on Brad's own addresses (self-BCC, tests).
    .filter((e) => !e.endsWith('@lakesidepainting.co.nz') && e !== 'bradleyjamesham@gmail.com');

  // Email's own sent date — the fallback when the PDF doesn't carry one.
  const sentAtISO = (() => {
    const raw = asString(body.sent_at);
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  })();

  // ── 4. Extract quote text (PDF preferred, body fallback) + LLM-parse ────
  const pdf = pickQuotePdf(body.attachments);
  let parsed: ParsedQuote | null = null;
  let parseSource: 'pdf' | 'body' | 'none' = 'none';
  try {
    let text = '';
    if (pdf) {
      try {
        text = (await extractPdfTextServer(pdf.buf)).text;
        parseSource = 'pdf';
      } catch (err) {
        console.warn('[inbound-quote-sent] PDF text extract failed; trying body', err);
      }
    }
    if (text.trim().length < 20 && plain) {
      text = plain;
      parseSource = 'body';
    }
    if (text.trim().length >= 20) {
      if (text.length > MAX_QUOTE_TEXT_CHARS) text = text.slice(0, MAX_QUOTE_TEXT_CHARS);
      parsed = await parseQuoteText(text);
    }
  } catch (err) {
    // Parser outage — matching can still proceed on recipient email alone.
    console.error('[inbound-quote-sent] quote parse failed', err);
    parsed = null;
    parseSource = 'none';
  }

  const totalIncl = parsed?.totalAmountInclGst;
  const amountExGst = parsed?.baseAmountExGst
    ?? (totalIncl != null ? Math.round((totalIncl / (1 + NZ_GST_RATE)) * 100) / 100 : undefined);
  const dateSent = parsed?.dateSent ?? sentAtISO ?? new Date().toISOString().slice(0, 10);
  const contactedAtISO = new Date(`${dateSent}T12:00:00`).toISOString();

  // ── 5. Match against open leads ─────────────────────────────────────────
  const { data: openJobs, error: jobsErr } = await admin
    .from('jobs')
    .select('id, name, status, client_name, client_email, location')
    .eq('business_id', businessId)
    .in('status', ['lead', 'quoted']);
  if (jobsErr) {
    console.error('[inbound-quote-sent] open-jobs query failed', jobsErr);
    return NextResponse.json({ ok: false, error: 'Failed to load open leads.' }, { status: 503 });
  }
  const match = matchJob((openJobs ?? []) as OpenJobRow[], recipients, parsed);

  // Precision gate: without a parsed total AND without an email match, do
  // nothing. The email is safe in Sent; Brad has the one-tap button.
  if (!match && totalIncl == null) {
    console.info('[inbound-quote-sent] skipped — no match and no parsed total', { subject });
    return NextResponse.json({ ok: true, skipped: true, reason: 'no-match-no-total' });
  }

  // ── 6a. Matched an existing lead → mark it quoted ───────────────────────
  if (match) {
    const jobId = match.job.id;

    // Latest quote row for the job (if any) drives dedup + update-vs-insert.
    const { data: existingQuotes } = await admin
      .from('quotes')
      .select('id, total_amount_incl_gst, status')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(1);
    const existing = existingQuotes?.[0] as
      | { id: string; total_amount_incl_gst: number | null; status: string | null }
      | undefined;

    // Dedup: already quoted at the same total → a re-send/retry, not news.
    // BUT still attach the PDF if the job doesn't have one — Brad often
    // prices a job by hand before this pipeline sees the email, and the
    // PDF is exactly the artefact that's missing. Additive only: no
    // status/money changes on the dedup path.
    if (
      match.job.status === 'quoted'
      && totalIncl != null
      && existing?.total_amount_incl_gst != null
      && Math.abs(existing.total_amount_incl_gst - totalIncl) <= DEDUP_TOLERANCE_DOLLARS
    ) {
      let pdfAttached = false;
      if (pdf) {
        const { data: existingPdfs } = await admin
          .from('quote_attachments')
          .select('id')
          .eq('quote_id', existing.id)
          .eq('kind', 'quote_pdf')
          .limit(1);
        if (!existingPdfs || existingPdfs.length === 0) {
          pdfAttached = await attachQuotePdf(admin, businessId, existing.id, pdf);
        }
      }
      console.info('[inbound-quote-sent] dedup hit', { jobId, totalIncl, pdfAttached });
      return NextResponse.json({ ok: true, jobId, dedup: true, pdfAttached });
    }

    // Quote row — update the latest or insert a fresh one.
    let quoteId: string | undefined = existing?.id;
    const quoteFields = {
      dateSent,
      status: 'sent' as const,
      ...(totalIncl != null ? { totalAmountInclGst: totalIncl } : {}),
      ...(amountExGst != null ? { baseAmountExGst: amountExGst } : {}),
      ...(parsed?.scopeSummary ? { scopeSummary: parsed.scopeSummary } : {}),
      ...(parsed?.jobType ? { jobType: parsed.jobType } : {}),
    };
    if (quoteId) {
      const { error } = await admin.from('quotes').update(quoteToRow(quoteFields)).eq('id', quoteId);
      if (error) console.error('[inbound-quote-sent] quote update failed', error);
    } else {
      const { data: inserted, error } = await admin
        .from('quotes')
        .insert(quoteToRow({
          businessId,
          jobId,
          clientName: parsed?.clientName ?? match.job.client_name ?? undefined,
          jobAddress: parsed?.jobAddress ?? match.job.location ?? undefined,
          ...quoteFields,
        }))
        .select('id')
        .single();
      if (error || !inserted) console.error('[inbound-quote-sent] quote insert failed', error);
      else quoteId = inserted.id as string;
    }

    // Attach the PDF (best-effort).
    let pdfAttached = false;
    if (pdf && quoteId) pdfAttached = await attachQuotePdf(admin, businessId, quoteId, pdf);

    // Flip the job. quote_amount is EX-GST (the app-wide convention) —
    // only written when we parsed a figure, never zeroed.
    const { error: jobErr } = await admin
      .from('jobs')
      .update({
        status: 'quoted',
        ...(amountExGst != null ? { quote_amount: amountExGst } : {}),
        follow_up_date: addDaysISO(dateSent, FOLLOW_UP_DAYS),
        last_contacted_date: contactedAtISO,
      })
      .eq('id', jobId);
    if (jobErr) {
      console.error('[inbound-quote-sent] job update failed', jobErr);
      return NextResponse.json({ ok: false, error: 'Failed to update the job.' }, { status: 503 });
    }

    // Contact history — sending the quote IS the contact.
    const { error: contactErr } = await admin.from('job_contacts').insert({
      business_id: businessId,
      job_id: jobId,
      contacted_at: contactedAtISO,
      direction: 'out',
      channel: 'quote-sent',
      note: 'Auto-logged from the quote email sent via Gmail.',
    });
    if (contactErr) console.error('[inbound-quote-sent] contact insert failed', contactErr);

    console.info('[inbound-quote-sent] lead marked quoted', {
      jobId, basis: match.basis, totalIncl, amountExGst, parseSource, pdfAttached,
    });
    return NextResponse.json({
      ok: true, jobId, matched: match.basis, totalInclGst: totalIncl ?? null, pdfAttached,
    });
  }

  // ── 6b. No match → create the job as quoted ─────────────────────────────
  // Only with solid data: a total plus at least a client name or address.
  // (totalIncl != null is guaranteed here by the precision gate above.)
  if (!parsed?.clientName && !parsed?.jobAddress && recipients.length === 0) {
    console.info('[inbound-quote-sent] skipped create — parse too thin', { subject });
    return NextResponse.json({ ok: true, skipped: true, reason: 'parse-too-thin' });
  }

  // Content dedup for the create path: a recently created quoted job with the
  // same normalised address or client email is this same quote arriving twice.
  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentQuoted } = await admin
    .from('jobs')
    .select('id, name, location, client_email, created_at')
    .eq('business_id', businessId)
    .eq('status', 'quoted')
    .gte('created_at', windowStart);
  const addrKey = normaliseForDedup(parsed?.jobAddress);
  const dup = (recentQuoted ?? []).find((r) => {
    const rowEmail = (r.client_email as string | null)?.toLowerCase();
    if (rowEmail && recipients.includes(rowEmail)) return true;
    if (!addrKey) return false;
    const rowLoc = normaliseForDedup((r.location as string | null) ?? undefined);
    return Boolean(rowLoc && (rowLoc === addrKey || rowLoc.includes(addrKey) || addrKey.includes(rowLoc)));
  });
  if (dup) {
    console.info('[inbound-quote-sent] create-path dedup hit', { jobId: dup.id });
    return NextResponse.json({ ok: true, jobId: dup.id as string, dedup: true });
  }

  const shortAddress = parsed?.jobAddress?.split(',')[0]?.trim();
  const name = (parsed?.jobType && shortAddress)
    ? `${parsed.jobType} — ${shortAddress}`
    : parsed?.jobType ?? shortAddress ?? (subject ? `Quote — ${subject}`.slice(0, 80) : 'Emailed quote');
  const notesParts = [
    'Created automatically from a quote email sent via Gmail.',
    ...(parsed?.scopeSummary ? [`\n\nScope: ${parsed.scopeSummary}`] : []),
    ...(subject ? [`\nEmail subject: ${subject}`] : []),
  ];

  const { data: created, error: createErr } = await admin
    .from('jobs')
    .insert({
      business_id: businessId,
      name,
      client_name: parsed?.clientName ?? 'Email quote',
      client_email: recipients[0] ?? null,
      location: parsed?.jobAddress ?? null,
      status: 'quoted',
      source: 'email',
      ...(amountExGst != null ? { quote_amount: amountExGst } : {}),
      follow_up_date: addDaysISO(dateSent, FOLLOW_UP_DAYS),
      last_contacted_date: contactedAtISO,
      notes: notesParts.join(''),
    })
    .select('id')
    .single();
  if (createErr || !created) {
    console.error('[inbound-quote-sent] job create failed', createErr);
    return NextResponse.json({ ok: false, error: 'Failed to create the job.' }, { status: 503 });
  }
  const jobId = created.id as string;

  const { data: insertedQuote, error: quoteErr } = await admin
    .from('quotes')
    .insert(quoteToRow({
      businessId,
      jobId,
      clientName: parsed?.clientName,
      jobAddress: parsed?.jobAddress,
      jobType: parsed?.jobType,
      scopeSummary: parsed?.scopeSummary,
      dateSent,
      status: 'sent',
      totalAmountInclGst: totalIncl ?? undefined,
      baseAmountExGst: amountExGst ?? undefined,
    }))
    .select('id')
    .single();
  if (quoteErr || !insertedQuote) console.error('[inbound-quote-sent] quote insert failed', quoteErr);

  let pdfAttached = false;
  if (pdf && insertedQuote) {
    pdfAttached = await attachQuotePdf(admin, businessId, insertedQuote.id as string, pdf);
  }

  const { error: contactErr } = await admin.from('job_contacts').insert({
    business_id: businessId,
    job_id: jobId,
    contacted_at: contactedAtISO,
    direction: 'out',
    channel: 'quote-sent',
    note: 'Auto-logged from the quote email sent via Gmail (job auto-created).',
  });
  if (contactErr) console.error('[inbound-quote-sent] contact insert failed', contactErr);

  console.info('[inbound-quote-sent] job created as quoted', {
    jobId, name, totalIncl, amountExGst, parseSource, pdfAttached,
  });
  return NextResponse.json({
    ok: true, jobId, created: true, name, totalInclGst: totalIncl ?? null, pdfAttached,
  });
}

// A browser GET should explain itself rather than 405 with no context.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'Use POST with x-webhook-secret header and a CloudMailin-shaped JSON payload.' },
    { status: 405 },
  );
}
