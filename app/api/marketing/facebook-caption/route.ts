// POST /api/marketing/facebook-caption
//
// Auth-gated. Body: { jobId }. Uses Claude to reshape the reviewed website copy
// (lead + overview) + job facts into a Facebook-flavoured caption — shorter,
// friendlier, with hashtags and (when the site page is live) a link back to it.
// Nothing is persisted here; the preview shows it for review/edit, then the
// caption is saved with the rest of the marketing blob via saveJobMarketing.
//
// Returns:
//   200 { ok: true, caption } · 400 invalid body · 401 auth · 500 config · 502 upstream

import { NextResponse } from 'next/server';
import { verifyBearer } from '@/lib/api-auth';
import { loadJobMarketingContext } from '@/lib/marketing-data';
import { generateFacebookPost } from '@/lib/marketing-ai';

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

// Mirrors slugify() in lib/website-publish.ts — kept identical so the project
// link we put in the caption matches the folder the publish step writes.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
}

export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: { jobId?: unknown; description?: unknown; overview?: unknown; services?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be valid JSON.' }, { status: 400 });
  }
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) return NextResponse.json({ ok: false, error: 'Missing jobId.' }, { status: 400 });

  // The preview can pass the copy currently on screen so the caption matches
  // exactly what Brad sees (and isn't stale against the last save).
  const liveDescription = typeof body.description === 'string' ? body.description : undefined;
  const liveOverview = Array.isArray(body.overview)
    ? body.overview.filter((p): p is string => typeof p === 'string')
    : undefined;
  const liveServices = Array.isArray(body.services)
    ? body.services.filter((s): s is string => typeof s === 'string')
    : undefined;

  try {
    const { job, marketing } = await loadJobMarketingContext(jobId);

    // Prefer on-screen services, then the curated saved ones, then the
    // work-type default.
    const services = (liveServices && liveServices.length > 0)
      ? liveServices
      : (marketing?.services && marketing.services.length > 0)
        ? marketing.services
        : (job.workType ? SERVICE_BY_WORKTYPE[job.workType] : undefined);

    // Only attach a project link once the website page is actually live, so we
    // never post a dead URL.
    const siteBase = (process.env.PAINTERS_WANAKA_SITE_URL || 'https://painterswanaka.co.nz').replace(/\/$/, '');
    const projectUrl = marketing?.status === 'published'
      ? `${siteBase}/projects/${slugify(job.name)}`
      : undefined;

    const post = await generateFacebookPost({
      jobName: job.name,
      location: job.location,
      services,
      description: liveDescription ?? marketing?.description,
      overview: liveOverview ?? marketing?.overview,
      scopeNotes: job.scopeNotes,
      stainProduct: job.stainProduct,
      projectUrl,
    });

    return NextResponse.json({ ok: true, caption: post.caption });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[marketing/facebook-caption]', msg);
    const isConfig = msg.includes('not set');
    return NextResponse.json(
      { ok: false, error: isConfig ? msg : 'Could not draft the caption — try again.', detail: msg },
      { status: isConfig ? 500 : 502 },
    );
  }
}
