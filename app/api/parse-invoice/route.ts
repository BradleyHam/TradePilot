// POST /api/parse-invoice
//
// Auth-gated wrapper around lib/invoice-parser.ts. Called from the
// browser by the Issue-invoice form's drop zone — the PDF itself is
// text-extracted client-side (lib/pdf/extract-text.ts) so only the
// extracted text hits this route.
//
// SAFETY:
//   1. Auth-gated. Caller must send Authorization: Bearer <supabase token>
//      so anonymous callers can't burn Anthropic credits.
//   2. Per-user in-memory rate limit (10/min). Resets on process restart.
//   3. Payload size cap enforced by parseInvoiceText (MAX_INVOICE_TEXT_CHARS).
//
// Returns:
//   200 { ok: true, parsed: ParsedInvoice }
//   400 invalid payload
//   401 missing/invalid auth token
//   413 payload too large
//   429 rate limited
//   500 server config (e.g. missing ANTHROPIC_API_KEY)
//   502 upstream LLM error

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseInvoiceText, MAX_INVOICE_TEXT_CHARS } from '@/lib/invoice-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

// In-memory rate limiter, per-process. Trimmed on each request.
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
  // ── 1. Auth ─────────────────────────────────────────────────────────────
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
  const verifier = createClient(supabaseUrl, supabaseAnonKey);
  const { data: userData, error: userErr } = await verifier.auth.getUser(token);
  if (userErr || !userData.user) {
    return NextResponse.json(
      { ok: false, error: 'Invalid or expired auth token.' },
      { status: 401 },
    );
  }
  const userId = userData.user.id;

  // ── 2. Rate limit ──────────────────────────────────────────────────────
  if (rateLimited(userId)) {
    return NextResponse.json(
      { ok: false, error: `Rate limit exceeded — max ${RATE_LIMIT_MAX} parses per minute.` },
      { status: 429 },
    );
  }

  // ── 3. Parse + validate body ───────────────────────────────────────────
  let body: { text?: unknown };
  try {
    body = (await req.json()) as { text?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Body must include a non-empty `text` string.' },
      { status: 400 },
    );
  }
  if (text.length > MAX_INVOICE_TEXT_CHARS) {
    return NextResponse.json(
      { ok: false, error: `Text too large (${text.length} chars, max ${MAX_INVOICE_TEXT_CHARS}).` },
      { status: 413 },
    );
  }

  // ── 4. Parse via shared library ────────────────────────────────────────
  try {
    const parsed = await parseInvoiceText(text);
    return NextResponse.json({ ok: true, parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[parse-invoice] parseInvoiceText failed:', msg);
    const isConfig = msg.includes('not set');
    return NextResponse.json(
      { ok: false, error: isConfig ? msg : 'Upstream parser error.', detail: msg },
      { status: isConfig ? 500 : 502 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'Use POST with a Bearer token and JSON body { text }.' },
    { status: 405 },
  );
}
