// POST /api/marketing/publish
//
// Auth-gated. Body: { jobId }. Runs the full publish pipeline (see
// lib/website-publish.ts): download photos → Claude vision SEO filenames/alt →
// sips webp → write a NEW public/projects/{slug}/ folder in the sibling
// painters-wanaka repo. Refuses to overwrite an existing project.
//
// LOCAL ONLY: it writes to the painters-wanaka working tree and shells out to
// macOS `sips`, so it must run from TradePilot on Brad's Mac (npm run dev).
// It's disabled on Vercel.
//
// Returns:
//   200 { ok: true, result }
//   400 invalid body / validation (no after photo, no description, slug exists) / running on Vercel
//   401 missing/invalid auth
//   500 server/config error (missing key, sips/site path)

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { publishJobToWebsite } from '@/lib/website-publish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vision calls + sips can take a while for a job with several photos.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (process.env.VERCEL) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Publishing runs locally — it writes the page into your painters-wanaka ' +
          'repo on your Mac. Open TradePilot on your computer (npm run dev) and ' +
          'publish from there.',
      },
      { status: 400 },
    );
  }

  const auth = await verifyBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: { jobId?: unknown; mode?: unknown };
  try {
    body = (await req.json()) as { jobId?: unknown; mode?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) return NextResponse.json({ ok: false, error: 'Missing jobId.' }, { status: 400 });
  const mode = body.mode === 'update' ? 'update' : 'create';

  try {
    const result = await publishJobToWebsite(jobId, { mode });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing/publish]', msg);
    // Config/environment problems are 500; everything else is an actionable
    // validation message (no after photo, no description, slug already exists).
    const isServer = msg.includes('not set') || msg.includes('sips') || msg.includes('painters-wanaka');
    return NextResponse.json({ ok: false, error: msg }, { status: isServer ? 500 : 400 });
  }
}
