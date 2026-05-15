// Browser-side PDF → text extractor used by the bill upload flow.
//
// pdf.js is heavy (~600KB with its worker) so we dynamically import it
// only when a user actually drops a PDF on the upload card. The rest of
// the app pays nothing for it. The extractor returns the concatenated
// text of the first N pages plus the character count — the calling code
// uses both to decide whether to send the payload to /api/parse-bill or
// reject as "too large".
//
// Layout-aware extraction would be nicer (multi-column invoices come out
// jumbled with the default join) but for NZ supplier bills the simple
// "all items joined with spaces" approach has been good enough across the
// test fixtures we've tried — Resene, Bunnings, Mitre 10 all produce
// readable text. If we hit a supplier whose layout confuses the parser,
// the right fix is to bump the LLM model rather than write a layout
// engine here.

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
 * Extract text from a PDF file selected in the browser. Resolves to the
 * concatenated text + page count. Rejects on parse errors (corrupt file,
 * encrypted PDF, image-only PDF with no text layer, etc).
 */
export async function extractPdfText(file: File): Promise<ExtractedPdf> {
  // Dynamic import so the pdf.js bundle is only fetched when this code
  // actually runs. Next.js code-splits this automatically.
  // Use the legacy build — it works without a separate worker file in
  // most Next environments. If we hit perf issues at scale we can switch
  // to the modern build and ship the worker as a static asset.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // pdf.js needs to know where its worker lives. We pin the worker URL
  // to the SAME version the API library reports — if we hardcode a
  // version, npm-updating pdfjs-dist will instantly break the parser
  // with "API version X does not match Worker version Y". Always pull
  // the version off the imported module.
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const totalPages = pdf.numPages;
  const pageCount = Math.min(totalPages, MAX_PAGES);
  let truncated = totalPages > pageCount;

  // Pull text page by page. We join intra-page items with spaces and
  // pages with double newlines so the LLM can see the boundary.
  const pageTexts: string[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Each item has `.str` (the text run) and a transform matrix; we
    // ignore layout and just concatenate. Empty strings dropped to avoid
    // double-spacing.
    const items = content.items as Array<{ str?: string }>;
    const pageText = items
      .map((it) => it.str ?? '')
      .filter((s) => s.length > 0)
      .join(' ');
    pageTexts.push(pageText);
  }

  let text = pageTexts.join('\n\n');
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    truncated = true;
  }

  return { text, pages: totalPages, truncated };
}
