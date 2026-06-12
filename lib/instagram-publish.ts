// Instagram publish pipeline — SERVER-ONLY, and effectively LOCAL-ONLY.
//
// Posts one finished job's chosen photos + caption to the Lakeside Painting
// Instagram account (a professional account linked to the Facebook Page) via
// the Instagram Content Publishing API.
//
// The IG API is different from the Facebook one in two awkward ways:
//   1. It does NOT take photo bytes — it takes a PUBLIC image URL and fetches
//      it server-side. We solve this by uploading the processed JPEGs to a
//      temp folder in the existing Supabase bucket and handing IG short-lived
//      signed URLs, then deleting the temp objects afterwards.
//   2. It enforces aspect ratios for feed images (roughly 4:5 portrait to
//      1.91:1 landscape) and rejects anything outside. We centre-crop each
//      photo into the legal range with sips before upload.
//
// Flow:
//   download chosen photos from Supabase
//     → sips: JPEG + resize + centre-crop into IG's legal aspect range
//     → upload temp JPEGs to Supabase → signed URLs
//     → 1 photo : POST /{ig}/media {image_url, caption} → /{ig}/media_publish
//     → 2+      : POST /{ig}/media {image_url, is_carousel_item} ×N
//                 → POST /{ig}/media {media_type=CAROUSEL, children, caption}
//                 → /{ig}/media_publish
//     → poll each container until FINISHED before publishing
//     → fetch permalink, persist posted state, delete temp objects.
//
// Setup: needs FACEBOOK_PAGE_ACCESS_TOKEN with instagram_basic +
// instagram_content_publish granted, and the IG account linked to the Page.
// INSTAGRAM_ACCOUNT_ID is optional — discovered from the Page when missing.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { supabaseAdmin } from './supabase/admin';
import { loadJobMarketingContext, saveJobInstagram } from './marketing-data';
import type { QuoteAttachment } from './types';

const STORAGE_BUCKET = 'quote-attachments';
const MAX_DIMENSION = 1440;          // IG renders at most 1440px wide
const MAX_PHOTOS = 10;               // carousel limit
const MIN_RATIO = 0.8;               // 4:5 portrait
const MAX_RATIO = 1.91;              // 1.91:1 landscape
const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.heic', '.heif']);

export interface InstagramPostResult {
  /** IG media id returned by /media_publish. */
  postId: string;
  /** Public permalink to the post, when the follow-up lookup succeeds. */
  permalink?: string;
  photoCount: number;
}

function requireToken(): string {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'Instagram is not configured. It reuses FACEBOOK_PAGE_ACCESS_TOKEN — set it ' +
      'in .env.local (with instagram_basic + instagram_content_publish granted), ' +
      'then restart the dev server.',
    );
  }
  return token;
}

/** Resolve the IG professional-account id: env var first, else ask the Page. */
async function resolveIgAccountId(token: string): Promise<string> {
  const fromEnv = process.env.INSTAGRAM_ACCOUNT_ID;
  if (fromEnv) return fromEnv;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!pageId) throw new Error('Set FACEBOOK_PAGE_ID or INSTAGRAM_ACCOUNT_ID in .env.local.');
  const json = await graphGet(`${pageId}?fields=instagram_business_account`, token) as {
    instagram_business_account?: { id?: string };
  };
  const id = json.instagram_business_account?.id;
  if (!id) {
    throw new Error(
      'No Instagram account is linked to the Facebook Page (or the token lacks ' +
      'instagram_basic). Link @lakesidepaintingnz to the Page in Meta Business ' +
      'Suite, regenerate the token, and try again.',
    );
  }
  return id;
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

async function downloadAttachment(att: QuoteAttachment): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(att.storagePath);
  if (error || !data) throw new Error(`Download failed for ${att.storagePath}: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Convert to JPEG, cap the long edge, and centre-crop into IG's legal aspect
 * range (0.8 … 1.91). sips -c crops from the centre, which is what we want.
 */
function toInstagramJpeg(buf: Buffer, ext: string): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-ig-'));
  try {
    const src = path.join(tmpDir, `src${ext || '.jpg'}`);
    const out = path.join(tmpDir, 'out.jpg');
    fs.writeFileSync(src, buf);
    try { execFileSync('sips', ['-Z', String(MAX_DIMENSION), src], { stdio: 'ignore' }); } catch { /* keep size */ }
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', out], { stdio: 'ignore' });

    // Read dimensions, then crop if the ratio is outside the legal band.
    const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out], { encoding: 'utf8' });
    const width = Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1] ?? 0);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(info)?.[1] ?? 0);
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio < MIN_RATIO) {
        // Too tall → crop height down to width / 0.8.
        const targetH = Math.floor(width / MIN_RATIO);
        execFileSync('sips', ['-c', String(targetH), String(width), out], { stdio: 'ignore' });
      } else if (ratio > MAX_RATIO) {
        // Too wide → crop width down to height * 1.91.
        const targetW = Math.floor(height * MAX_RATIO);
        execFileSync('sips', ['-c', String(height), String(targetW), out], { stdio: 'ignore' });
      }
    }
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Upload a processed JPEG to a temp path in the bucket; returns the path. */
async function uploadTempJpeg(businessId: string, jpg: Buffer): Promise<string> {
  const tempPath = `${businessId}/ig-temp/${crypto.randomUUID()}.jpg`;
  const { error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(tempPath, jpg, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error(`Temp upload failed: ${error.message}`);
  return tempPath;
}

async function signTempUrl(tempPath: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(tempPath, 3600);
  if (error || !data?.signedUrl) throw new Error(`Could not sign temp URL: ${error?.message ?? 'no URL'}`);
  return data.signedUrl;
}

async function graphGet(urlPath: string, token: string): Promise<Record<string, unknown>> {
  const sep = urlPath.includes('?') ? '&' : '?';
  const res = await fetch(`${GRAPH}/${urlPath}${sep}access_token=${encodeURIComponent(token)}`);
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  if (!res.ok || json.error) {
    const e = json.error as { message?: string; error_user_msg?: string } | undefined;
    throw new Error(`Instagram API error: ${e?.error_user_msg || e?.message || res.statusText}`);
  }
  return json;
}

async function graphPost(urlPath: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${urlPath}`, { method: 'POST', body: form });
  } catch (err) {
    throw new Error(`Couldn't reach Instagram: ${(err as Error).message}`);
  }
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  if (!res.ok || json.error) {
    const e = json.error as { message?: string; error_user_msg?: string } | undefined;
    throw new Error(`Instagram rejected the post: ${e?.error_user_msg || e?.message || res.statusText}`);
  }
  return json;
}

/** Wait until a media container is FINISHED (IG processes the fetched image async). */
async function waitForContainer(containerId: string, token: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const json = await graphGet(`${containerId}?fields=status_code`, token) as { status_code?: string };
    if (json.status_code === 'FINISHED') return;
    if (json.status_code === 'ERROR') {
      throw new Error('Instagram could not process one of the photos (container ERROR).');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Timed out waiting for Instagram to process a photo.');
}

/** Best-effort permalink lookup; never throws (the post already succeeded). */
async function fetchPermalink(mediaId: string, token: string): Promise<string | undefined> {
  try {
    const json = await graphGet(`${mediaId}?fields=permalink`, token) as { permalink?: unknown };
    return typeof json.permalink === 'string' ? json.permalink : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Post a job's photos + caption to the Instagram account. Same photo-selection
 * contract as postJobToFacebook: an explicit ordered `photoAttachmentIds`
 * wins; otherwise hero-first afters, falling back to befores.
 */
export async function postJobToInstagram(
  jobId: string,
  opts: { caption?: string; photoAttachmentIds?: string[] } = {},
): Promise<InstagramPostResult> {
  const token = requireToken();
  assertSipsAvailable();
  const igId = await resolveIgAccountId(token);

  const { job, before, after, process: processImgs, marketing } = await loadJobMarketingContext(jobId);

  const caption = (opts.caption ?? marketing?.instagram?.caption ?? '').trim();
  if (!caption) throw new Error('Add a caption before posting to Instagram.');

  const afterImgs = after.filter(isImageAttachment);
  const beforeImgs = before.filter(isImageAttachment);
  const allImages = [...afterImgs, ...beforeImgs, ...processImgs.filter(isImageAttachment)];
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
  if (chosen.length === 0) throw new Error('Add at least one photo before posting to Instagram.');
  chosen = chosen.slice(0, MAX_PHOTOS);

  // Download + normalise everything first so a bad photo fails the whole post
  // before anything is half-published.
  const jpgs = await Promise.all(chosen.map(async (att) => {
    const ext = path.extname(att.fileName ?? att.storagePath).toLowerCase();
    const buf = await downloadAttachment(att);
    return toInstagramJpeg(buf, ext);
  }));

  // Temp-upload for public URLs; always cleaned up, even on failure.
  const tempPaths: string[] = [];
  try {
    const urls: string[] = [];
    for (const jpg of jpgs) {
      const p = await uploadTempJpeg(job.businessId, jpg);
      tempPaths.push(p);
      urls.push(await signTempUrl(p));
    }

    let creationId: string;
    if (urls.length === 1) {
      const r = await graphPost(`${igId}/media`, {
        image_url: urls[0],
        caption,
        access_token: token,
      });
      creationId = r.id as string;
      await waitForContainer(creationId, token);
    } else {
      const childIds: string[] = [];
      for (const url of urls) {
        const r = await graphPost(`${igId}/media`, {
          image_url: url,
          is_carousel_item: 'true',
          access_token: token,
        });
        childIds.push(r.id as string);
      }
      await Promise.all(childIds.map((id) => waitForContainer(id, token)));
      const r = await graphPost(`${igId}/media`, {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption,
        access_token: token,
      });
      creationId = r.id as string;
      await waitForContainer(creationId, token);
    }

    const pub = await graphPost(`${igId}/media_publish`, {
      creation_id: creationId,
      access_token: token,
    });
    const postId = pub.id as string;
    const permalink = await fetchPermalink(postId, token);

    await saveJobInstagram(job, marketing, {
      caption,
      photoAttachmentIds: chosen.map((a) => a.id),
      status: 'posted',
      postId,
      permalink,
      postedAt: new Date().toISOString(),
    });

    return { postId, permalink, photoCount: jpgs.length };
  } finally {
    if (tempPaths.length > 0) {
      // Best-effort cleanup — orphaned temp objects are harmless but untidy.
      void supabaseAdmin.storage.from(STORAGE_BUCKET).remove(tempPaths).then(
        ({ error }) => { if (error) console.warn('[instagram-publish] temp cleanup failed:', error.message); },
      );
    }
  }
}
