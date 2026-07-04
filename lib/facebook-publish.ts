// Facebook publish pipeline — SERVER-ONLY, and effectively LOCAL-ONLY.
//
// Posts one finished job's chosen photos + caption to the Lakeside Painting
// Facebook Page via the Graph API:
//   download chosen photos from Supabase Storage
//     → sips normalises each to JPEG (Graph API won't take webp/HEIC)
//     → 1 photo  : POST /{page}/photos with caption  (published photo story)
//     → 2+ photos: POST /{page}/photos published=false (×N) → /{page}/feed
//                  with attached_media (a multi-photo post)
//     → fetch permalink_url, persist the posted state on the marketing blob.
//
// Why local-only: it shells out to macOS `sips` for image conversion, exactly
// like lib/website-publish.ts, so it runs from TradePilot on Brad's Mac
// (npm run dev). The route guards it off on Vercel. The Graph calls themselves
// are plain HTTPS — if we ever drop the sips dependency (convert in JS) this
// could run server-side too.
//
// Setup: needs FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN (a long-lived,
// never-expiring Page token) in .env.local. Optional FACEBOOK_GRAPH_VERSION.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { supabaseAdmin } from './supabase/admin';
import { loadJobMarketingContext, saveJobFacebook } from './marketing-data';
import type { QuoteAttachment } from './types';

const STORAGE_BUCKET = 'quote-attachments';
const MAX_DIMENSION = 2048;          // resize cap before upload
const MAX_PHOTOS = 10;               // keep albums sane
const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.heic', '.heif']);

export interface FacebookPostResult {
  /** Graph API post id (`{pageId}_{storyId}`). */
  postId: string;
  /** permalink_url to the post, when the follow-up lookup succeeds. */
  permalink?: string;
  /** How many photos were attached. */
  photoCount: number;
}

function requireEnv(): { pageId: string; token: string } {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    throw new Error(
      'Facebook is not configured. Set FACEBOOK_PAGE_ID and ' +
      'FACEBOOK_PAGE_ACCESS_TOKEN in .env.local, then restart the dev server.',
    );
  }
  return { pageId, token };
}

function assertSipsAvailable(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Photo conversion needs macOS `sips` — post from TradePilot on your Mac.');
  }
  try {
    execFileSync('sips', ['--help'], { stdio: 'ignore' });
  } catch {
    throw new Error('`sips` not found. It ships with macOS — are you on a Mac?');
  }
}

function isImageAttachment(a: QuoteAttachment): boolean {
  const name = (a.fileName ?? a.storagePath).toLowerCase();
  return IMAGE_EXTS.has(path.extname(name));
}

async function downloadPath(storagePath: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Download failed for ${storagePath}: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Resize + convert any supported image to JPEG bytes via sips. */
function toJpegBytes(buf: Buffer, ext: string): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-fb-'));
  try {
    const src = path.join(tmpDir, `src${ext || '.jpg'}`);
    const out = path.join(tmpDir, 'out.jpg');
    fs.writeFileSync(src, buf);
    try { execFileSync('sips', ['-Z', String(MAX_DIMENSION), src], { stdio: 'ignore' }); } catch { /* keep size */ }
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', out], { stdio: 'ignore' });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** POST a multipart form to the Graph API and surface its error message cleanly. */
async function graphPost(urlPath: string, form: FormData): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${urlPath}`, { method: 'POST', body: form });
  } catch (err) {
    throw new Error(`Couldn't reach Facebook: ${(err as Error).message}`);
  }
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  if (!res.ok || json.error) {
    const e = json.error as { message?: string; code?: number; error_user_msg?: string } | undefined;
    const detail = e?.error_user_msg || e?.message || res.statusText || 'unknown error';
    throw new Error(`Facebook rejected the post: ${detail}`);
  }
  return json;
}

/** Best-effort permalink lookup; never throws (the post already succeeded). */
async function fetchPermalink(postId: string, token: string): Promise<string | undefined> {
  try {
    const url = `${GRAPH}/${postId}?fields=permalink_url&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const json = (await res.json()) as { permalink_url?: unknown };
    return typeof json.permalink_url === 'string' ? json.permalink_url : undefined;
  } catch {
    return undefined;
  }
}

function jpegBlob(buf: Buffer): Blob {
  // Copy into a fresh Uint8Array so the Blob owns a clean ArrayBuffer slice.
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
}

/**
 * Post a job's photos + caption to the Facebook Page.
 *
 * Photo selection: an explicit ordered `photoAttachmentIds` wins; otherwise we
 * default to the chosen hero after-photo first then the rest of the after
 * photos, falling back to before photos only if there are no after photos.
 */
export async function postJobToFacebook(
  jobId: string,
  opts: {
    caption?: string;
    photoAttachmentIds?: string[];
    /**
     * attachmentId → temp storage path of a pre-labelled JPEG (BEFORE/AFTER
     * pill burned in client-side). When present for a chosen photo, the
     * override bytes are posted instead of the original attachment.
     */
    photoOverrides?: Record<string, string>;
  } = {},
): Promise<FacebookPostResult> {
  const { pageId, token } = requireEnv();
  assertSipsAvailable();

  const { job, before, after, process: processImgs, testimonial, marketing } = await loadJobMarketingContext(jobId);

  const caption = (opts.caption ?? marketing?.facebook?.caption ?? '').trim();
  if (!caption) throw new Error('Add a caption before posting to Facebook.');

  const afterImgs = after.filter(isImageAttachment);
  const beforeImgs = before.filter(isImageAttachment);
  // Testimonial cards join the id-resolvable pool so an explicitly chosen
  // card isn't silently dropped; the no-explicit-selection default below
  // still leads with after photos.
  const allImages = [
    ...testimonial.filter(isImageAttachment),
    ...afterImgs,
    ...beforeImgs,
    ...processImgs.filter(isImageAttachment),
  ];
  const byId = new Map(allImages.map((a) => [a.id, a]));

  let chosen: QuoteAttachment[];
  if (opts.photoAttachmentIds && opts.photoAttachmentIds.length > 0) {
    chosen = opts.photoAttachmentIds
      .map((id) => byId.get(id))
      .filter((a): a is QuoteAttachment => !!a);
  } else {
    const heroId = marketing?.heroAfterId ?? marketing?.heroAttachmentId;
    const heroIsAfter = heroId ? afterImgs.some((a) => a.id === heroId) : false;
    chosen = heroIsAfter
      ? [byId.get(heroId!)!, ...afterImgs.filter((a) => a.id !== heroId)]
      : (afterImgs.length > 0 ? afterImgs : beforeImgs);
  }
  if (chosen.length === 0) throw new Error('Add at least one photo before posting to Facebook.');
  chosen = chosen.slice(0, MAX_PHOTOS);

  // Download + normalise every photo to JPEG before any upload, so a bad photo
  // fails the whole post before we've half-published an album.
  const jpgs = await Promise.all(chosen.map(async (att) => {
    const override = opts.photoOverrides?.[att.id];
    if (override) {
      // Labelled temp copies must live under this business's prefix — never
      // fetch arbitrary bucket paths on behalf of the client.
      if (!override.startsWith(`${job.businessId}/`)) {
        throw new Error('Invalid labelled-photo path.');
      }
      return toJpegBytes(await downloadPath(override), '.jpg');
    }
    const ext = path.extname(att.fileName ?? att.storagePath).toLowerCase();
    const buf = await downloadPath(att.storagePath);
    return toJpegBytes(buf, ext);
  }));

  let postId: string;
  if (jpgs.length === 1) {
    // Single photo → a published photo story carries the caption directly.
    const form = new FormData();
    form.append('source', jpegBlob(jpgs[0]), 'photo.jpg');
    form.append('caption', caption);
    form.append('access_token', token);
    const r = await graphPost(`${pageId}/photos`, form);
    postId = (typeof r.post_id === 'string' && r.post_id) || (r.id as string);
  } else {
    // Multi-photo → upload each unpublished, then a feed post ties them together.
    const mediaIds: string[] = [];
    for (let i = 0; i < jpgs.length; i++) {
      const f = new FormData();
      f.append('source', jpegBlob(jpgs[i]), `photo-${i}.jpg`);
      f.append('published', 'false');
      f.append('access_token', token);
      const r = await graphPost(`${pageId}/photos`, f);
      if (typeof r.id === 'string') mediaIds.push(r.id);
    }
    if (mediaIds.length === 0) throw new Error('Facebook accepted none of the photos — nothing was posted.');
    const f = new FormData();
    f.append('message', caption);
    mediaIds.forEach((id, i) => f.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
    f.append('access_token', token);
    const r = await graphPost(`${pageId}/feed`, f);
    postId = r.id as string;
  }

  const permalink = await fetchPermalink(postId, token);

  // Persist the posted state on the marketing blob (best-effort; the post is
  // already live so a settings miss is non-fatal).
  await saveJobFacebook(job, marketing, {
    caption,
    photoAttachmentIds: chosen.map((a) => a.id),
    status: 'posted',
    postId,
    permalink,
    postedAt: new Date().toISOString(),
  });

  return { postId, permalink, photoCount: jpgs.length };
}
