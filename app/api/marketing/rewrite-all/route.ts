// POST /api/marketing/rewrite-all
//
// Auth-gated. Body: { description, overview, instruction }. Rewrites the WHOLE
// page body (lead + paragraphs) in one pass so it can shorten holistically —
// merging or dropping paragraphs — rather than block by block. Powers the
// "Edit whole page" controls in the project preview.
//
// Returns:
//   200 { ok: true, description, overview } · 400 invalid · 401 auth · 500 config · 502 upstream

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { rewriteProjectBody } from '@/lib/marketing-ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: { description?: unknown; overview?: unknown; instruction?: unknown };
  try {
    body = (await req.json()) as { description?: unknown; overview?: unknown; instruction?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const description = typeof body.description === 'string' ? body.description : '';
  const overview = Array.isArray(body.overview) ? body.overview.filter((p): p is string => typeof p === 'string') : [];
  const instruction = typeof body.instruction === 'string' ? body.instruction : '';
  if (!description.trim() && overview.length === 0) {
    return NextResponse.json({ ok: false, error: 'Nothing to rewrite.' }, { status: 400 });
  }
  if (!instruction.trim()) {
    return NextResponse.json({ ok: false, error: 'Missing instruction.' }, { status: 400 });
  }

  try {
    const out = await rewriteProjectBody({ description, overview, instruction });
    return NextResponse.json({ ok: true, description: out.description, overview: out.overview });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing/rewrite-all]', msg);
    const isConfig = msg.includes('not set');
    return NextResponse.json(
      { ok: false, error: isConfig ? msg : 'Could not rewrite — try again.', detail: msg },
      { status: isConfig ? 500 : 502 },
    );
  }
}
