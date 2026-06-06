// POST /api/marketing/facebook-post
//
// Auth-gated. Body: { jobId, caption?, photoAttachmentIds? }. Posts the job's
// chosen photos + caption to the Lakeside Facebook Page via the Graph API
// (see lib/facebook-publish.ts), then persists the post id + permalink.
//
// LOCAL ONLY: image normalisation shells out to macOS `sips`, so it must run
// from TradePilot on Brad's Mac (npm run dev). Disabled on Vercel.
//
// Returns:
//   200 { ok: true, result } · 400 invalid body / not configured / on Vercel
//   401 auth · 500 server/config (missing sips)

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { postJobToFacebook } from '@/lib/facebook-publish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Downloading + converting several photos and 2+ Graph round-trips takes a moment.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (process.env.VERCEL) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Posting to Facebook runs locally (it converts your photos with macOS ' +
          'tools). Open TradePilot on your computer (npm run dev) and post from there.',
      },
      { status: 400 },
    );
  }

  const auth = await verifyBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: { jobId?: unknown; caption?: unknown; photoAttachmentIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) return NextResponse.json({ ok: false, error: 'Missing jobId.' }, { status: 400 });
  const caption = typeof body.caption === 'string' ? body.caption : undefined;
  const photoAttachmentIds = Array.isArray(body.photoAttachmentIds)
    ? body.photoAttachmentIds.filter((x): x is string => typeof x === 'string')
    : undefined;

  try {
    const result = await postJobToFacebook(jobId, { caption, photoAttachmentIds });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing/facebook-post]', msg);
    // Config/environment problems are 500; everything else (no caption, no
    // photo, Facebook rejection) is an actionable 400.
    const isServer = msg.includes('sips') || msg.includes('not configured');
    return NextResponse.json({ ok: false, error: msg }, { status: isServer ? 500 : 400 });
  }
}
