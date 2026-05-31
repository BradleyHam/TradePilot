'use client';

// Shared client-side "turn a file into a ParsedBill" pipeline, used by both
// the bill-upload card (creates a new draft) and the BillItemsAttacher
// (adds line items to an existing bill). Keeping it in one place means the
// PDF-text-first / vision-fallback / image-compress logic can't drift
// between the two entry points.

import { extractPdfText } from '@/lib/pdf/extract-text';
import { compressImage } from '@/lib/image-compress';
import { supabase } from '@/lib/supabase/client';
import type { ParsedBill } from '@/lib/types';

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB
// Image media types the vision parser accepts (PDF handled separately).
const VISION_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
// Keep under the route's MAX_BILL_VISION_BYTES (and Vercel's body limit).
const MAX_VISION_BYTES = 3_000_000;

export interface ParsedBillFile {
  parsed: ParsedBill;
  /** The exact file to archive in Storage — the compressed JPEG for a
   *  photo, or the original PDF. */
  fileToStore: File;
}

/** base64-encode a File's bytes (no data: prefix), chunked to avoid
 *  blowing the call stack on large buffers. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** POST a parse request (text OR vision) and normalise the result. */
async function postParse(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true; parsed: ParsedBill } | { ok: false; message: string }> {
  try {
    const res = await fetch('/api/parse-bill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return { ok: false, message: `Parser failed: ${json.error ?? `HTTP ${res.status}`}` };
    }
    return { ok: true, parsed: json.parsed as ParsedBill };
  } catch (err) {
    console.error('[parse-bill-file] parse request failed:', err);
    return { ok: false, message: 'Couldn\'t reach the parser. Check your connection and try again.' };
  }
}

/**
 * Validate + parse a supplier-bill file into a ParsedBill.
 * - PDF: try text extraction first (fast + exact); fall back to vision on
 *   the raw PDF for image-only / scanned PDFs.
 * - Image: compress, then read with vision.
 */
export async function parseBillFile(
  file: File,
  token: string,
): Promise<{ ok: true; result: ParsedBillFile } | { ok: false; message: string }> {
  if (file.size === 0) return { ok: false, message: 'File is empty.' };
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type.startsWith('image/');
  if (!isPdf && !isImage) {
    return { ok: false, message: 'Upload a PDF or a photo of the bill (JPG or PNG).' };
  }
  if (isPdf && file.size > MAX_PDF_BYTES) {
    return { ok: false, message: `PDF too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 10MB.` };
  }

  if (isPdf) {
    let extractedText = '';
    try {
      extractedText = (await extractPdfText(file)).text.trim();
    } catch (err) {
      console.warn('[parse-bill-file] PDF text extract failed; trying vision:', err);
    }
    if (extractedText.length >= 20) {
      const r = await postParse(token, { text: extractedText });
      return r.ok ? { ok: true, result: { parsed: r.parsed, fileToStore: file } } : r;
    }
    if (file.size > MAX_VISION_BYTES) {
      return { ok: false, message: 'This looks like a scanned PDF and it\'s too large to read. Snap a photo of it instead.' };
    }
    const r = await postParse(token, { fileBase64: await fileToBase64(file), mediaType: 'application/pdf' });
    return r.ok ? { ok: true, result: { parsed: r.parsed, fileToStore: file } } : r;
  }

  // Image path
  let toSend = file;
  try {
    toSend = (await compressImage(file)).file;
  } catch (err) {
    console.warn('[parse-bill-file] image compress failed; sending original:', err);
  }
  if (!(VISION_IMAGE_TYPES as ReadonlyArray<string>).includes(toSend.type)) {
    return { ok: false, message: 'Couldn\'t read this photo format — try a JPG or PNG, or upload the PDF.' };
  }
  if (toSend.size > MAX_VISION_BYTES) {
    return { ok: false, message: 'Photo is too large to read — try taking it again.' };
  }
  const r = await postParse(token, { fileBase64: await fileToBase64(toSend), mediaType: toSend.type });
  return r.ok ? { ok: true, result: { parsed: r.parsed, fileToStore: toSend } } : r;
}

/**
 * Upload a bill document to the `bill-pdfs` bucket. Returns the object path
 * (NOT a URL — URLs expire), or null if the upload failed (caller decides
 * how to surface that; the parsed fields are still useful without the doc).
 */
export async function uploadBillDocument(file: File, businessId: string): Promise<string | null> {
  const ext = file.type === 'application/pdf' ? 'pdf'
    : file.type === 'image/png' ? 'png'
    : file.type === 'image/webp' ? 'webp'
    : file.type === 'image/gif' ? 'gif'
    : 'jpg';
  const objectPath = `${businessId}/${crypto.randomUUID()}.${ext}`;
  try {
    const { error } = await supabase.storage
      .from('bill-pdfs')
      .upload(objectPath, file, {
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
        upsert: false,
      });
    if (error) {
      console.warn('[parse-bill-file] Storage upload failed; continuing without doc:', error);
      return null;
    }
    return objectPath;
  } catch (err) {
    console.warn('[parse-bill-file] Storage upload threw:', err);
    return null;
  }
}
