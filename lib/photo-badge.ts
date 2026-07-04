// Photo badge compositor — CLIENT-ONLY (uses <canvas>).
//
// Burns a small "BEFORE" / "AFTER" pill onto the top-left corner of a photo
// for social posts, so viewers scrolling a Facebook album instantly know
// which shot is which. Runs in the browser at post time:
//
//   signed URL → <img> (CORS) → canvas → pill overlay → JPEG Blob
//
// The labelled copies are uploaded as TEMPORARY storage objects and handed
// to the post route as per-photo overrides — the original attachments in
// storage are never modified (the website galleries keep clean photos).
//
// Badge design: charcoal pill at ~72% opacity, white uppercase Poppins with
// wide tracking, sized relative to the photo's short edge so it looks the
// same weight on a 4032px camera shot and a 1080px screenshot.

const MAX_LONG_EDGE = 2048; // matches the FB pipeline's own resize cap
const JPEG_QUALITY = 0.9;

const PILL_FILL = 'rgba(17, 20, 24, 0.72)';
const PILL_TEXT = '#ffffff';

export type PhotoLabel = 'BEFORE' | 'AFTER';

/** Load an image from a (CORS-enabled) URL for canvas use. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Supabase storage sends ACAO: *
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Photo failed to load for labelling.'));
    img.src = url;
  });
}

/** roundRect with an arcTo fallback for older WebKit. */
function pillPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const r = h / 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Composite `label` onto the photo at `url` and return a JPEG Blob.
 *
 * `fontFamily` is the brand font's CSS family (next/font Poppins). The
 * caller should await document.fonts.load for the 600 weight first — a miss
 * degrades to system sans rather than failing.
 */
export async function labelPhoto(
  url: string,
  label: PhotoLabel,
  fontFamily: string,
): Promise<Blob> {
  const img = await loadImage(url);

  // Cap the long edge (the post pipeline would downscale anyway).
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(img, 0, 0, w, h);

  // Pill geometry, relative to the photo's short edge.
  const shortEdge = Math.min(w, h);
  const pillH = Math.max(40, Math.round(shortEdge * 0.072));
  const margin = Math.round(shortEdge * 0.04);
  const fontSize = Math.round(pillH * 0.44);

  ctx.font = `600 ${fontSize}px ${fontFamily}`;
  try {
    // Wide tracking reads "label", not "word". Not supported everywhere;
    // silently fine without it.
    ctx.letterSpacing = `${Math.round(fontSize * 0.14)}px`;
  } catch { /* older engines */ }
  const textW = ctx.measureText(label).width;
  const padX = Math.round(pillH * 0.55);
  const pillW = Math.ceil(textW + padX * 2);

  ctx.fillStyle = PILL_FILL;
  pillPath(ctx, margin, margin, pillW, pillH);
  ctx.fill();

  ctx.fillStyle = PILL_TEXT;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, margin + padX, margin + pillH / 2 + fontSize * 0.06);

  const blob: Blob | null = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
  });
  if (!blob) throw new Error("Couldn't encode the labelled photo.");
  return blob;
}
