// POST /api/marketing/draft
//
// Auth-gated. Body: { jobId }. Uses Claude to draft the FULL project-page copy
// (title + lead description + 2–4 overview paragraphs) in the voice/length of
// the live site. Nothing is persisted — the preview shows it for review/edit.
//
// Returns:
//   200 { ok: true, title, description, overview }
//   400 invalid body · 401 auth · 500 config · 502 upstream

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { loadJobMarketingContext } from '@/lib/marketing-data';
import { generateProjectCopy } from '@/lib/marketing-ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SERVICE_BY_WORKTYPE: Record<string, string[]> = {
  interior: ['Interior Painting'],
  exterior: ['Exterior Painting'],
  cedar: ['Cedar Restoration'],
  wallpaper: ['Wallpaper Installation'],
  roof: ['Roof Painting'],
  mixed: ['Exterior Painting', 'Interior Painting'],
};

export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: { jobId?: unknown };
  try {
    body = (await req.json()) as { jobId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) return NextResponse.json({ ok: false, error: 'Missing jobId.' }, { status: 400 });

  try {
    const { job, before, after, marketing } = await loadJobMarketingContext(jobId);
    const services = job.workType ? SERVICE_BY_WORKTYPE[job.workType] : undefined;
    const copy = await generateProjectCopy({
      jobName: job.name,
      location: job.location,
      services,
      scopeNotes: job.scopeNotes,
      stainProduct: job.stainProduct,
      draft: marketing?.description,
      beforeCount: before.length,
      afterCount: after.length,
    });
    return NextResponse.json({
      ok: true,
      title: copy.title,
      description: copy.description,
      overview: copy.overview,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing/draft]', msg);
    const isConfig = msg.includes('not set');
    return NextResponse.json(
      { ok: false, error: isConfig ? msg : 'Could not draft the page — try again.', detail: msg },
      { status: isConfig ? 500 : 502 },
    );
  }
}
