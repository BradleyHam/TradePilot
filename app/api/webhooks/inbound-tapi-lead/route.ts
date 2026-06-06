// POST /api/webhooks/inbound-tapi-lead
//
// Receives forwarded Tapi "Provide a quote" emails from CloudMailin (or any
// compatible inbound-mail provider) and creates a `lead`-status job in Trade
// Pilot — so property-manager quote requests that come in via Tapi land in
// the app automatically instead of only living in the inbox.
//
// Pipeline (mirrors /api/webhooks/inbound-bill):
//   1. Auth via shared secret — `x-webhook-secret` header OR basic-auth in
//      the URL (CloudMailin free tier can't set custom headers, so the
//      `https://anything:<secret>@host/...` form is supported too).
//   2. Parse the CloudMailin JSON payload (subject, plain, html, from).
//   3. Guard: only act on genuine "Provide a quote" requests. Other Tapi
//      mail types (quote accepted/declined, new work order, confirm work)
//      are accepted with 200 + {skipped:true} so CloudMailin doesn't retry,
//      but no lead is created.
//   4. Parse the email into lead fields (address, job type, PM, agency,
//      their message, Tapi link).
//   5. Dedupe: skip if a Tapi lead with the same address + job type was
//      created in the last 7 days (catches retries / double-forwards while
//      still allowing a genuine re-quote of the same property months later).
//   6. Insert a status='lead', source='tapi' job via the admin client.
//
// We use the admin (service-role) client because an inbound webhook has no
// auth.uid(), and RLS on `jobs` requires owner-of-business = auth.uid().
// TRADEPILOT_BUSINESS_ID pins which business the lead lands against (same
// single-user pattern as the website-enquiry + inbound-bill webhooks).

import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  isTapiQuoteRequest,
  parseTapiQuoteEmail,
  buildTapiLeadFields,
  normaliseForDedup,
} from '@/lib/tapi-lead-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// How far back to look for a matching Tapi lead when deduping. Long enough
// to absorb provider retries and accidental re-forwards; short enough that
// a genuine re-quote of the same property weeks/months later still comes
// through as a fresh lead.
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
 * Authenticate via shared secret. Accepts the secret either as an
 * `x-webhook-secret` header or as basic-auth credentials in the URL
 * (`https://anything:<secret>@host/...`), matching either the username or
 * the password — same dual scheme as the inbound-bill route so CloudMailin
 * free tier works.
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
  const expectedSecret = process.env.TAPI_LEAD_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: TAPI_LEAD_WEBHOOK_SECRET not set.' },
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
  const fromAddress =
    asString(body.envelope?.from) ?? asString(headers['from']) ?? asString(headers['From']);

  // ── 4. Guard: only genuine quote requests become leads ──────────────────
  if (!isTapiQuoteRequest({ from: fromAddress, subject, plain, html })) {
    // Accept-and-ignore: a 200 stops the provider retrying, but we make no
    // lead. Covers "Quote accepted/declined", "New work order", etc.
    console.info('[inbound-tapi-lead] skipped non-quote-request email', { subject, fromAddress });
    return NextResponse.json({ ok: true, skipped: true, reason: 'not-a-quote-request' });
  }

  // ── 5. Parse → lead fields ──────────────────────────────────────────────
  const parsed = parseTapiQuoteEmail({ subject, plain, html });
  const lead = buildTapiLeadFields(parsed);

  // ── 6. Dedupe on content within the recent window ───────────────────────
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: dedupErr } = await admin
    .from('jobs')
    .select('id, name, location, created_at')
    .eq('business_id', businessId)
    .eq('source', 'tapi')
    .gte('created_at', windowStart);
  if (dedupErr) {
    // Don't block on a dedupe failure — better to risk a dupe than drop a lead.
    console.error('[inbound-tapi-lead] dedupe query failed', dedupErr);
  } else if (recent && recent.length > 0) {
    const incomingKey = `${normaliseForDedup(lead.location)}|${normaliseForDedup(lead.name)}`;
    const dup = recent.find(
      (r) =>
        `${normaliseForDedup(r.location as string | undefined)}|${normaliseForDedup(r.name as string | undefined)}` ===
        incomingKey,
    );
    if (dup) {
      console.info('[inbound-tapi-lead] dedup hit', { jobId: dup.id, subject });
      return NextResponse.json({ ok: true, jobId: dup.id as string, dedup: true });
    }
  }

  // ── 7. Insert the lead ──────────────────────────────────────────────────
  const { data: inserted, error: insertErr } = await admin
    .from('jobs')
    .insert({
      business_id: businessId,
      name: lead.name,
      client_name: lead.clientName,
      location: lead.location ?? null,
      status: 'lead',
      source: 'tapi',
      notes: lead.notes,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('[inbound-tapi-lead] insert failed', insertErr);
    return NextResponse.json(
      { ok: false, error: 'Failed to create lead.', detail: insertErr?.message },
      { status: 500 },
    );
  }

  console.info('[inbound-tapi-lead] lead created', {
    jobId: inserted.id,
    name: lead.name,
    client: lead.clientName,
  });
  return NextResponse.json({ ok: true, jobId: inserted.id, name: lead.name });
}

// A browser GET should explain itself rather than 405 with no context.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'Use POST with x-webhook-secret header and a CloudMailin JSON payload.' },
    { status: 405 },
  );
}
