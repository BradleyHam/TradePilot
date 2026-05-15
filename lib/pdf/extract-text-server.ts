// Server-side PDF → text extractor used by the inbound-bill webhook.
//
// We talk directly to pdfjs-dist (not the pdf-parse v2 wrapper) because
// pdfjs's internal `import('./pdf.worker.mjs')` triggers Turbopack chunk
// rewriting inside Next.js route handlers — even with the package marked
// as a serverExternalPackage, the dynamic import gets intercepted and
// the worker file is "not found" at a phantom `[app-route]` path.
//
// Workaround: call `getDocument({ disableWorker: true })`. pdfjs falls
// back to running synchronously on the main Node thread, no worker
// resolution needed. Slower than the worker path in theory, but for
// 1–3-page supplier bills the cost is unmeasurable.
//
// Returns the same { text, pages, truncated } shape as the browser
// helper (lib/pdf/extract-text.ts) so the upstream pipeline doesn't
// care which extractor produced the input.

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

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
  // pdfjs accepts a typed-array view. Buffer is already a Uint8Array
  // subclass but we copy to be explicit — pdfjs may take ownership.
  const data = new Uint8Array(buffer);

  // disableWorker: true keeps the parse on the main thread. isEvalSupported
  // false suppresses a noisy warning about CSP eval — we don't need it for
  // text extraction. useSystemFonts false avoids canvas/font lookups that
  // would otherwise try to call into Node's `canvas` module (not installed).
  //
  // `disableWorker` is missing from pdfjs-dist's published types (it's a
  // legitimate but undocumented option), so we widen the parameters shape
  // locally. The runtime checks the field via property access, so passing
  // it through `as` is safe.
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
  } as Parameters<typeof pdfjs.getDocument>[0] & { disableWorker?: boolean });

  const pdf = await loadingTask.promise;
  try {
    const totalPages = pdf.numPages;
    const pageCount = Math.min(totalPages, MAX_PAGES);
    let truncated = totalPages > pageCount;

    const pageTexts: string[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items as Array<{ str?: string }>;
      const pageText = items
        .map((it) => it.str ?? '')
        .filter((s) => s.length > 0)
        .join(' ');
      pageTexts.push(pageText);
      // Release the page's resources eagerly to avoid memory build-up
      // across multiple webhook invocations in the same process.
      page.cleanup();
    }

    let text = pageTexts.join('\n\n');
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
    }

    return { text, pages: totalPages, truncated };
  } finally {
    // Always destroy the document so pdfjs releases its internal state.
    // Without this we'd leak parsed PDFs across webhook calls.
    await pdf.destroy().catch(() => { /* best effort */ });
  }
}
