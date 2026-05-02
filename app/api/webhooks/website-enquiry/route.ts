// POST /api/webhooks/website-enquiry
//
// Receives contact-form submissions from painterswanaka.co.nz and creates
// a `lead`-status job in Trade Pilot. Authenticated by a shared secret in
// the `x-webhook-secret` header (NOT Supabase auth — the website is the
// caller, no signed-in user).
//
// Uses the Supabase admin client (service role) so it can write into the
// user's business without an auth.uid(). The business id is taken from
// the TRADEPILOT_BUSINESS_ID env var, which is hardcoded for the single-
// user setup. When we generalise this to multiple businesses, the secret
// will key into a per-business config row.
//
// Idempotency: if the same email + same first-100-chars of message already
// landed within the last 5 minutes we skip the insert and return ok=true
// with `dedup: true`. Stops form double-submits creating duplicate leads.

import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Don't try to prerender or static-optimise this route. It runs on demand.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface EnquiryPayload {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  /** Optional. Long-form text from a textarea/message field. */
  message?: unknown;
  /** Optional. Service category from a dropdown, e.g. "interior", "exterior". */
  service?: unknown;
  /** e.g. "/contact", "/services/exterior". Stored in notes for context. */
  pageUrl?: unknown;
  /** Defaults to 'website' when omitted. */
  source?: unknown;
}

/** Map raw service slugs from the form's dropdown to friendlier display text. */
function prettyService(slug: string): string {
  const normalized = slug.toLowerCase().trim();
  const map: Record<string, string> = {
    interior: 'Interior painting',
    exterior: 'Exterior painting',
    roof: 'Roof painting',
    wallpapering: 'Wallpapering',
    wallpaper: 'Wallpapering',
    commercial: 'Commercial',
    residential: 'Residential',
    other: 'Other services',
  };
  return map[normalized] ?? slug;
}

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the admin client per-request rather than at module load. Keeps
 * the build healthy even if env vars haven't been set in a given env.
 */
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

export async function POST(req: Request) {
  // ── 1. Authenticate the caller via shared secret ──────────────────────
  const expectedSecret = process.env.WEBSITE_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: WEBSITE_WEBHOOK_SECRET not set.' },
      { status: 500 },
    );
  }
  const presentedSecret = req.headers.get('x-webhook-secret');
  if (presentedSecret !== expectedSecret) {
    return NextResponse.json(
      { ok: false, error: 'Invalid or missing webhook secret.' },
      { status: 401 },
    );
  }

  // ── 2. Parse + validate body ───────────────────────────────────────────
  let body: EnquiryPayload;
  try {
    body = (await req.json()) as EnquiryPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }

  const name = asString(body.name);
  const email = asString(body.email);
  const phone = asString(body.phone);
  const message = asString(body.message);
  const serviceRaw = asString(body.service);
  const service = serviceRaw ? prettyService(serviceRaw) : undefined;
  const pageUrl = asString(body.pageUrl);
  const source = asString(body.source) ?? 'website';

  if (!name) {
    return NextResponse.json(
      { ok: false, error: 'Missing required field: name.' },
      { status: 400 },
    );
  }
  if (!email && !phone) {
    return NextResponse.json(
      { ok: false, error: 'Need at least one of email or phone.' },
      { status: 400 },
    );
  }
  // Message and service are both optional. The hero form on the website
  // doesn't have a message field and has an unselected service dropdown by
  // default — a name + contact-method-only submission is still a real lead
  // that we want to capture. The job will be named "Website enquiry — {name}"
  // in that case.

  // ── 3. Resolve business id ─────────────────────────────────────────────
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

  // ── 4. Dedupe: any lead from the same email + same source within the last
  //    5 minutes is treated as a duplicate. We don't bother matching message
  //    contents — two submissions from the same email in 5 minutes is almost
  //    certainly a double-click rather than two genuine enquiries.
  if (email) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: existing, error: dedupeErr } = await admin
      .from('jobs')
      .select('id')
      .eq('business_id', businessId)
      .eq('client_email', email)
      .eq('source', source)
      .gte('created_at', fiveMinAgo)
      .limit(1);
    if (dedupeErr) {
      console.error('[website-enquiry] dedupe query failed', dedupeErr);
      // Don't block on dedupe failure — better to risk a dupe than lose a lead.
    } else if (existing && existing.length > 0) {
      return NextResponse.json({ ok: true, jobId: existing[0].id as string, dedup: true });
    }
  }

  // ── 5. Compose name + notes ────────────────────────────────────────────
  // Notes (priority): full message → service line → "Website enquiry — no
  // additional details provided." Always append the page URL if present.
  const notesParts: string[] = [];
  if (message) {
    notesParts.push(message);
  } else if (service) {
    notesParts.push(`Service requested: ${service}`);
  } else {
    notesParts.push('Website enquiry — no additional details provided. Follow up with the contact details on file.');
  }
  if (pageUrl) notesParts.push(`\n\n— from ${pageUrl}`);
  const notes = notesParts.join('');

  // Job name (priority):
  //   1. First sentence of message if it's a reasonable length
  //   2. "{Service} — {name}" if a service was selected
  //   3. "Website enquiry — {name}" as the boring fallback
  let jobName: string;
  if (message) {
    const firstLine = message.split(/[\n.]/)[0].trim();
    jobName = firstLine.length >= 4 && firstLine.length <= 80
      ? firstLine
      : `Website enquiry — ${name}`;
  } else if (service) {
    jobName = `${service} — ${name}`;
  } else {
    jobName = `Website enquiry — ${name}`;
  }

  const { data: inserted, error: insertErr } = await admin
    .from('jobs')
    .insert({
      business_id: businessId,
      name: jobName,
      client_name: name,
      client_email: email ?? null,
      client_phone: phone ?? null,
      status: 'lead',
      source,
      notes,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('[website-enquiry] insert failed', insertErr);
    return NextResponse.json(
      { ok: false, error: 'Failed to create lead.', detail: insertErr?.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, jobId: inserted.id });
}

// Reject everything that isn't POST so accidental GETs from a browser
// give a useful error rather than a 405 with no body.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'Use POST with x-webhook-secret header.' },
    { status: 405 },
  );
}
