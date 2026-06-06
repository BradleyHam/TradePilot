// POST /api/parse-quote
//
// Auth-gated. Body: { text } (plain text extracted client-side from the quote
// PDF). Returns the structured quote fields — the Mark-as-quoted sheet uses
// totalAmountInclGst to auto-fill the total. Mirrors /api/parse-bill.
//
// Returns:
//   200 { ok: true, parsed: ParsedQuote }
//   400 invalid body · 401 auth · 413 too large · 429 rate limited
//   500 server config (ANTHROPIC_API_KEY) · 502 upstream LLM error

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { parseQuoteText, MAX_QUOTE_TEXT_CHARS } from '@/lib/quote-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 15;
const requestLog = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (requestLog.get(userId) ?? []).filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) { requestLog.set(userId, recent); return true; }
  recent.push(now);
  requestLog.set(userId, recent);
  return false;
}

export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (rateLimited(auth.userId)) {
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded — try again in a minute.' }, { status: 429 });
  }

  let body: { text?: unknown };
  try {
    body = (await req.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return NextResponse.json({ ok: false, error: 'Body must include a non-empty `text` string.' }, { status: 400 });
  if (text.length > MAX_QUOTE_TEXT_CHARS) {
    return NextResponse.json({ ok: false, error: `Text too large (${text.length} chars, max ${MAX_QUOTE_TEXT_CHARS}).` }, { status: 413 });
  }

  try {
    const parsed = await parseQuoteText(text);
    return NextResponse.json({ ok: true, parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[parse-quote]', msg);
    const isConfig = msg.includes('not set');
    return NextResponse.json(
      { ok: false, error: isConfig ? msg : 'Upstream parser error.', detail: msg },
      { status: isConfig ? 500 : 502 },
    );
  }
}
