// POST /api/draft-quote
//
// Auth-gated wrapper around lib/quote-drafter.ts. Called from the
// browser by the AI-quote sheet on the JobDetailSheet.
//
// Body shape:
//   { jobId: string; hint?: string }
//
// The route looks up the job + template + comparables server-side
// (using the user's auth token so RLS applies) — the client passes
// only the jobId so it can't smuggle in fake context.
//
// Returns:
//   200 { ok: true, draft: DraftedQuote }
//   400 invalid payload (missing jobId)
//   401 missing/invalid auth token
//   403 jobId not visible to this user
//   404 job not found
//   429 rate limited
//   500 server config (e.g. missing ANTHROPIC_API_KEY)
//   502 upstream LLM error or non-JSON response

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { draftQuote, QuoteDrafterError, type ComparableJob } from '@/lib/quote-drafter';
import { rowToJob } from '@/lib/supabase/mappers';
import type { Job, QuoteTemplate } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Quote drafting takes 20-30s — bump the function timeout above Vercel's
// default 10s. Hobby plan tops out at 60s which is plenty.
export const maxDuration = 60;

// Per-user rate limit. Drafting a quote is much more expensive than
// parsing a bill (longer context, longer output) so we cap tighter.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 4;

const requestLog = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (requestLog.get(userId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_LIMIT_MAX) {
    requestLog.set(userId, recent);
    return true;
  }
  recent.push(now);
  requestLog.set(userId, recent);
  return false;
}

export async function POST(req: Request) {
  // ── 1. Auth ─────────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'Missing Authorization: Bearer <token> header.' },
      { status: 401 },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: Supabase env vars missing.' },
      { status: 500 },
    );
  }

  // Build a per-request client bound to the user's token so all reads
  // below go through RLS. Reading the job via this client doubles as
  // the authorization check — if the user doesn't have access to the
  // job, the row simply isn't returned.
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    return NextResponse.json(
      { ok: false, error: 'Invalid or expired auth token.' },
      { status: 401 },
    );
  }
  const userId = userData.user.id;

  // ── 2. Rate limit ──────────────────────────────────────────────────
  if (rateLimited(userId)) {
    return NextResponse.json(
      { ok: false, error: `Rate limit exceeded — max ${RATE_LIMIT_MAX} drafts per minute.` },
      { status: 429 },
    );
  }

  // ── 3. Parse payload ───────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'Body must be an object.' }, { status: 400 });
  }
  const { jobId, hint } = body as { jobId?: unknown; hint?: unknown };
  if (typeof jobId !== 'string' || !jobId) {
    return NextResponse.json({ ok: false, error: 'jobId required.' }, { status: 400 });
  }
  const hintStr = typeof hint === 'string' ? hint : undefined;

  // ── 4. Load job ────────────────────────────────────────────────────
  const { data: jobRow, error: jobErr } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (jobErr) {
    return NextResponse.json(
      { ok: false, error: `Failed to load job: ${jobErr.message}` },
      { status: 500 },
    );
  }
  if (!jobRow) {
    // Could be 403 (RLS hid it) or 404 (genuinely missing). PostgREST
    // doesn't differentiate; we collapse to 404 for safety so we don't
    // leak which jobs exist outside the user's business.
    return NextResponse.json({ ok: false, error: 'Job not found.' }, { status: 404 });
  }
  const job: Job = rowToJob(jobRow);

  // ── 5. Load the business's quote template ──────────────────────────
  const { data: templateRow } = await supabase
    .from('settings')
    .select('*')
    .eq('business_id', job.businessId)
    .eq('key', 'quote_template')
    .maybeSingle();
  let template: QuoteTemplate;
  try {
    template = templateRow?.value
      ? (JSON.parse(templateRow.value) as QuoteTemplate)
      : defaultTemplate();
  } catch {
    template = defaultTemplate();
  }

  // ── 6. Load comparable past jobs ───────────────────────────────────
  // Strongest signal — paid jobs in the same workType (or similar
  // prep level) tell Claude what Brad's market actually pays. We cap
  // at 5 most recent to keep prompt size manageable.
  const { data: compRows } = await supabase
    .from('jobs')
    .select('*')
    .eq('business_id', job.businessId)
    .eq('status', 'paid')
    .order('end_date', { ascending: false, nullsFirst: false })
    .limit(20);
  const comparableJobs: ComparableJob[] = (compRows ?? [])
    .map((r) => rowToJob(r))
    .filter((j) => {
      // Prefer same-work-type matches. If workType is unknown on
      // either side, still include — Claude can decide whether it's
      // relevant.
      if (!job.workType || !j.workType) return true;
      return j.workType === job.workType;
    })
    .slice(0, 5)
    .map((j) => ({
      name: j.name,
      workType: j.workType,
      prepLevel: j.prepLevel,
      paintAreaM2: j.surfaceAreaM2,
      totalPaid: j.invoiceAmount ?? j.quoteAmount ?? 0,
      yearCompleted: j.endDate
        ? new Date(j.endDate).getFullYear()
        : new Date(j.updatedAt).getFullYear(),
    }))
    .filter((c) => c.totalPaid > 0); // exclude paid-but-no-amount rows

  // ── 7. Draft ───────────────────────────────────────────────────────
  try {
    const draft = await draftQuote({ job, template, comparableJobs, hint: hintStr });
    return NextResponse.json({ ok: true, draft });
  } catch (err) {
    if (err instanceof QuoteDrafterError) {
      const status =
        err.code === 'no_api_key' ? 500
        : err.code === 'parse_failed' ? 502
        : err.code === 'empty_response' ? 502
        : 502;
      return NextResponse.json(
        { ok: false, error: err.message, code: err.code },
        { status },
      );
    }
    return NextResponse.json(
      { ok: false, error: `Unexpected error: ${(err as Error).message ?? 'unknown'}` },
      { status: 500 },
    );
  }
}

/**
 * Defensive fallback if a business has no quote_template row (shouldn't
 * happen post-migration 014, but lets the route still return something
 * useful if the seed didn't fire). Matches the seeded shape.
 */
function defaultTemplate(): QuoteTemplate {
  return {
    header: {},
    paymentTerms: {
      depositPercent: 30,
      depositDueDays: 7,
      balanceDue: 'on_completion',
    },
    validityDays: 30,
    gstTreatment: 'incl',
  };
}

