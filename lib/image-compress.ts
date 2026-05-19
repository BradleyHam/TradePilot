/**
 * Client-side image compression for scope photo uploads.
 *
 * Why: phones produce 4-12 MB JPEGs which is wasteful in Storage when
 * the quoting assistant only needs ~1600px wide images to read the
 * scene. Resize + re-encode reduces a typical 8 MB photo to ~400 KB,
 * a 20× saving with zero perceptible quality loss for the model.
 *
 * Strategy:
 *   1. If the file is not an image (e.g. PDF), pass it through unchanged.
 *   2. Decode via createImageBitmap (HEIC support varies by browser; we
 *      fall back to <img>+canvas if createImageBitmap throws).
 *   3. Compute new size with the longer edge clamped to MAX_LONG_EDGE.
 *   4. Re-encode as JPEG at quality 0.82.
 *
 * Returns a new File object with the same base name + `.jpg` extension
 * so the storage path stays clean. Original filename minus extension
 * is preserved so the user still recognises the photo later.
 */

const MAX_LONG_EDGE = 1600;
const JPEG_QUALITY = 0.82;

export interface CompressResult {
  file: File;
  originalSize: number;
  compressedSize: number;
  skipped: boolean; // true if we passed the file through (non-image, etc)
}

export async function compressImage(file: File): Promise<CompressResult> {
  // Non-images get passed through unchanged.
  if (!file.type.startsWith('image/')) {
    return { file, originalSize: file.size, compressedSize: file.size, skipped: true };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // createImageBitmap doesn't support some formats (HEIC on Chrome).
    // Fall back to <img>-based decode. If that also fails, give up and
    // upload the original — the user gets a working photo, just bigger.
    try {
      bitmap = await decodeViaImg(file);
    } catch {
      return { file, originalSize: file.size, compressedSize: file.size, skipped: true };
    }
  }

  const { width: targetW, height: targetH } = scaleToFit(bitmap.width, bitmap.height, MAX_LONG_EDGE);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { file, originalSize: file.size, compressedSize: file.size, skipped: true };
  }
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();

  const blob: Blob | null = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
  });
  if (!blob) {
    return { file, originalSize: file.size, compressedSize: file.size, skipped: true };
  }

  // Re-encoded as JPEG; rewrite the extension so the storage path matches
  // the actual content type. Keep the user-facing base name so they can
  // still identify the photo.
  const baseName = stripExtension(file.name) || 'photo';
  const compressed = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
  return {
    file: compressed,
    originalSize: file.size,
    compressedSize: compressed.size,
    skipped: false,
  };
}

function scaleToFit(w: number, h: number, maxLongEdge: number): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= maxLongEdge) return { width: w, height: h };
  const ratio = maxLongEdge / longest;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

async function decodeViaImg(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Image decode failed'));
      i.src = url;
    });
    // createImageBitmap on an HTMLImageElement is widely supported and
    // gives us the same return type the rest of the code expects.
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}
