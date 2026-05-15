// Server-side PDF → text extractor used by the inbound-bill webhook.
//
// History:
//   - pdfjs-dist directly didn't work on Vercel — its v5 build needs
//     DOMMatrix/ImageData/Path2D globals that don't exist in serverless
//     Node, and the workaround (@napi-rs/canvas) can't be loaded in
//     Vercel's runtime either.
//   - pdf-parse (v2) wraps pdfjs-dist so it inherits the same problem.
//
// `unpdf` is purpose-built for serverless: it ships a custom pdfjs build
// with all the canvas/DOM dependencies stripped out, so text extraction
// works in any Node runtime including Vercel/Cloudflare/Deno.
//
// Returns the same { text, pages, truncated } shape as the browser
// helper (lib/pdf/extract-text.ts) so the upstream pipeline doesn't
// care which extractor produced the input.

import { extractText, getDocumentProxy } from 'unpdf';

const MAX_PAGES = 12;
const MAX_CHARS = 30_000;

export interface ExtractedPdf {
  /** Plain-text representation of the PDF, capped at MAX_CHARS. */
  text: string;
  /** Total pages in the file (not just the ones we extracted). */
  pages: number;
  /** True if we truncated either because of page or character cap. */
  truncated: boolean;
}

/**
 * Extract text from a PDF buffer (e.g. attachment from an inbound email).
 *
 * Rejects on:
 *   - corrupt or unparseable PDF
 *   - encrypted PDF requiring a password
 *   - image-only PDFs (returns empty text; caller should treat that as
 *     "no text layer, can't parse")
 */
export async function extractPdfTextServer(buffer: Buffer): Promise<ExtractedPdf> {
  // unpdf accepts a Uint8Array. Buffer is a Uint8Array subclass; copy is
  // cheap and guards against shared-buffer surprises.
  const data = new Uint8Array(buffer);

  // Load once to get page count, then pass to extractText so we don't
  // load the document twice. mergePages: false gives us per-page text so
  // we can truncate at the page boundary and know the original total.
  const doc = await getDocumentProxy(data);
  const totalPages = doc.numPages;

  // extractText takes the loaded document and returns text per page +
  // page count. We could call extractText on the buffer directly but
  // we'd lose the totalPages-before-truncation signal we use below.
  const { text: pagesText } = await extractText(doc, { mergePages: false });

  // pagesText is string[] when mergePages:false. Truncate to MAX_PAGES.
  const pageCount = Math.min(totalPages, MAX_PAGES);
  let truncated = totalPages > pageCount;

  const slice = pagesText.slice(0, pageCount);
  let text = slice.join('\n\n').trim();

  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    truncated = true;
  }

  return { text, pages: totalPages, truncated };
}
