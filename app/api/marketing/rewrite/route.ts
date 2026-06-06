// POST /api/marketing/rewrite
//
// Auth-gated. Body: { text, instruction, context? }. Rewrites one block of
// copy (title, lead, or a paragraph) per a short instruction — "make it
// longer", "more professional", "shorter", etc. Powers the per-block AI
// edit buttons in the project preview.
//
// Returns:
//   200 { ok: true, text } · 400 invalid body · 401 auth · 500 config · 502 upstream

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { rewriteCopy } from '@/lib/marketing-ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: { text?: unknown; instruction?: unknown; context?: unknown };
  try {
    body = (await req.json()) as { text?: unknown; instruction?: unknown; context?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text : '';
  const instruction = typeof body.instruction === 'string' ? body.instruction : '';
  const context = typeof body.context === 'string' ? body.context : undefined;
  if (!text.trim()) return NextResponse.json({ ok: false, error: 'Nothing to rewrite.' }, { status: 400 });
  if (!instruction.trim()) return NextResponse.json({ ok: false, error: 'Missing instruction.' }, { status: 400 });

  try {
    const out = await rewriteCopy({ text, instruction, context });
    return NextResponse.json({ ok: true, text: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing/rewrite]', msg);
    const isConfig = msg.includes('not set');
    return NextResponse.json(
      { ok: false, error: isConfig ? msg : 'Could not rewrite — try again.', detail: msg },
      { status: isConfig ? 500 : 502 },
    );
  }
}
