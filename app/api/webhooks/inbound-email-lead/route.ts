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
import {
  parseEmailLead,
  buildEmailLeadFields,
  normaliseForDedup,
  type EmailLeadFields,
} from '@/lib/email-lead-parser';

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

  console.info('[inbound-email-lead] lead created', {
    jobId: inserted.id,
    name: lead.name,
    confidence,
  });
  return NextResponse.json({ ok: true, jobId: inserted.id, name: lead.name });
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
