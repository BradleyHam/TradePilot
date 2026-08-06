// POST /api/parse-scope
//
// Auth-gated. Body: { text } — plain text extracted client-side from a
// quote PDF. Returns the job's on-site scope split into what's included
// and what isn't, for display to employees. Mirrors /api/parse-quote.
//
// The extractor is under strict instruction to emit no prices, and
// stripMoney() scrubs anything that slips through — these lists are
// employee-visible via jobs_public. The owner still reviews before save.
//
// Returns:
//   200 { ok: true, scope: ExtractedScope }
//   400 invalid body · 401 auth · 413 too large · 429 rate limited
//   500 server config (ANTHROPIC_API_KEY) · 502 upstream LLM error

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { extractScopeFromText, MAX_SCOPE_TEXT_CHARS } from '@/lib/scope-extractor';

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
  if (!text) {
    return NextResponse.json({ ok: false, error: 'Body must include a non-empty `text` string.' }, { status: 400 });
  }
  if (text.length > MAX_SCOPE_TEXT_CHARS) {
    return NextResponse.json(
      { ok: false, error: `Text too large (${text.length} chars, max ${MAX_SCOPE_TEXT_CHARS}).` },
      { status: 413 },
    );
  }

  try {
    const scope = await extractScopeFromText(text);
    return NextResponse.json({ ok: true, scope });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[parse-scope]', msg);
    const isConfig = msg.includes('not set');
    return NextResponse.json(
      { ok: false, error: isConfig ? msg : 'Upstream parser error.', detail: msg },
      { status: isConfig ? 500 : 502 },
    );
  }
}
