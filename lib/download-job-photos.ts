// ── "Download all photos" for a job ────────────────────────────────────────
//
// Brad shoots photos on his phone on site; they land in Supabase Storage via
// the job's Documents & photos panel. This pulls them back down onto a laptop
// in one tap as a single .zip, foldered by kind (Before / After / Progress /
// Scope), so he can hand them to a client or file them without tapping every
// thumbnail.
//
// Runs entirely in the browser: the attachments bucket is private and RLS is
// owner-scoped, so we mint short-lived signed URLs with the user's own session
// (exactly like the thumbnail grid already does) and fetch through those. No
// API route, no service-role key, and no Vercel memory/timeout ceiling on a
// job with 200 photos.

import { supabase } from '@/lib/supabase/client';
import type { QuoteAttachment } from '@/lib/types';
import { buildZip, downloadBlob, safeName, uniquifyName, type ZipEntry } from '@/lib/zip-download';

const BUCKET = 'quote-attachments';

/** How many photos to fetch at once. Enough to saturate a link, few enough
 *  not to hammer a phone on mobile data. */
const CONCURRENCY = 4;

/** Signed-URL lifetime. Generous — a 200-photo job on slow wifi takes a while
 *  and we don't want URLs expiring mid-download. */
const SIGNED_URL_TTL_SECONDS = 3600;

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp'];

/** True if the filename looks like a photo (as opposed to a plan/quote PDF). */
export function isPhotoAttachment(a: QuoteAttachment): boolean {
  const n = (a.fileName ?? a.storagePath).toLowerCase();
  return IMAGE_EXTS.some((ext) => n.endsWith(ext));
}

/** Folder name inside the zip for each attachment kind. Mirrors the section
 *  headings in the Documents & photos panel so the zip matches the screen. */
function folderForKind(kind: QuoteAttachment['kind']): string {
  switch (kind) {
    case 'before_photo':      return 'Before';
    case 'after_photo':       return 'After';
    case 'process_photo':     return 'Progress';
    case 'scope_photo':       return 'Scope photos';
    case 'testimonial_image': return 'Testimonial';
    case 'plan':              return 'Plans';
    case 'quote_pdf':         return 'Quote PDF';
    case 'other':             return 'Other';
    default:                  return 'Photos';
  }
}

export interface DownloadProgress {
  /** Photos fetched so far. */
  done: number;
  /** Photos we're fetching in total. */
  total: number;
  /** True once fetching is finished and we're assembling the .zip. */
  zipping: boolean;
}

export interface DownloadResult {
  ok: boolean;
  /** How many photos made it into the zip. */
  downloaded: number;
  /** How many couldn't be fetched (they're listed in the console). */
  failed: number;
  /** Set when nothing could be downloaded at all. */
  error?: string;
}

/**
 * Fetch every photo attached to a job, zip it in the browser, and save it as
 * `{Job name} photos.zip`.
 *
 * Partial failures don't sink the whole download — anything that fetches gets
 * zipped, and the caller is told how many were skipped so it can say so on
 * screen (AGENTS.md: loud failures).
 *
 * @param attachments the job's attachments (already filtered to this job)
 * @param jobName     used for the zip filename
 * @param onProgress  called as each photo lands, for the button's counter
 */
export async function downloadJobPhotos(
  attachments: QuoteAttachment[],
  jobName: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  const photos = attachments.filter(isPhotoAttachment);
  if (photos.length === 0) {
    return { ok: false, downloaded: 0, failed: 0, error: 'No photos on this job yet.' };
  }

  const total = photos.length;
  onProgress?.({ done: 0, total, zipping: false });

  // One batched signing request for the whole set — same call the thumbnail
  // grid makes, so this is warm and cheap.
  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(photos.map((p) => p.storagePath), SIGNED_URL_TTL_SECONDS);

  if (signError || !signed) {
    console.error('[download-job-photos] Failed to sign URLs:', signError);
    return {
      ok: false,
      downloaded: 0,
      failed: total,
      error: "Couldn't get download links. Check your connection and try again.",
    };
  }

  const urlByPath = new Map<string, string>();
  for (const row of signed) {
    if (row.path && row.signedUrl) urlByPath.set(row.path, row.signedUrl);
  }

  // Pre-compute the in-zip path for each photo so names stay unique and
  // stable regardless of the order the fetches complete in.
  const usedNames = new Set<string>();
  const targets = photos.map((a) => {
    const raw = a.fileName ?? a.storagePath.split('/').pop() ?? 'photo.jpg';
    // Storage names are prefixed `{uuid}__` on upload — strip that back off so
    // the zip has the name the photo had on the phone.
    const original = raw.includes('__') ? raw.slice(raw.indexOf('__') + 2) : raw;
    const dot = original.lastIndexOf('.');
    const stem = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot).toLowerCase() : '.jpg';
    const name = `${safeName(stem, 'photo')}${ext}`;
    return {
      attachment: a,
      url: urlByPath.get(a.storagePath),
      zipPath: uniquifyName(`${folderForKind(a.kind)}/${name}`, usedNames),
    };
  });

  const entries: ZipEntry[] = [];
  let done = 0;
  let failed = 0;

  // Fixed-size worker pool. Each worker pulls the next index off a shared
  // cursor — simpler than chunking and keeps the link busy when one photo is
  // much bigger than its neighbours.
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const t = targets[i];
      try {
        if (!t.url) throw new Error('no signed URL');
        const res = await fetch(t.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        entries.push({
          name: t.zipPath,
          data: new Uint8Array(buf),
          modified: t.attachment.createdAt ? new Date(t.attachment.createdAt) : undefined,
        });
      } catch (err) {
        failed += 1;
        console.error(`[download-job-photos] Failed: ${t.attachment.storagePath}`, err);
      } finally {
        done += 1;
        onProgress?.({ done, total, zipping: false });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  if (entries.length === 0) {
    return {
      ok: false,
      downloaded: 0,
      failed,
      error: "Couldn't download any of the photos. Check your connection and try again.",
    };
  }

  onProgress?.({ done, total, zipping: true });

  // Keep the zip in the display order rather than completion order.
  const orderByPath = new Map(targets.map((t, i) => [t.zipPath, i]));
  entries.sort((a, b) => (orderByPath.get(a.name) ?? 0) - (orderByPath.get(b.name) ?? 0));

  try {
    const blob = buildZip(entries);
    downloadBlob(blob, `${safeName(jobName, 'Job')} photos.zip`);
  } catch (err) {
    console.error('[download-job-photos] Zip failed:', err);
    return {
      ok: false,
      downloaded: 0,
      failed: total,
      error: err instanceof Error ? err.message : "Couldn't build the zip file.",
    };
  }

  return { ok: true, downloaded: entries.length, failed };
}
