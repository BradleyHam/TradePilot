// lib/dulux-email-parser.ts
//
// Fallback parser for Dulux's "secure link" invoice emails.
//
// Background: until ~May 2026 Dulux NZ emailed invoices as PDF attachments
// (from no_reply@dulux.co.nz) — those parse perfectly via the normal PDF
// pipeline, line items and all. They then switched this account to the AU
// DuluxGroup platform, which sends an HTML email (from
// noreply.duluxnz@e.duluxgroup.com.au) with NO attachment and a "click here
// to securely download" link. That link lands on a JS page that gates the
// PDF behind an account-number check, so the inbound-bill link-follower
// can't fetch it server-side ("returned a non-PDF response").
//
// BUT the email body itself spells out everything we need to record the
// bill:
//
//     Hi LAKESIDE PAINTING LIMITED,
//     The following invoice is available to download:
//     Invoice No: 0909398550
//     Date: 03/06/2026
//     Amount: $11.71
//     PO: CROMWELL RACETRACK
//     Click here to securely download.
//
// So rather than fight the gate, we parse those labelled fields straight
// out of the email and create the bill (correct amount, date, invoice
// number, and job via the PO). The one thing the body can't give us is the
// itemised line items — those only live in the PDF — so the caller flags
// the bill "line items pending" and stashes the secure link, and dropping
// the PDF on the bill later merges the line items in by invoice number.
//
// Pure + dependency-free (string ops only) so it's deterministic and
// unit-testable — no LLM call needed, the format is fixed.

import type { ParsedBill } from '@/lib/types';

export interface DuluxBodyParseResult {
  /** A ParsedBill built from the email body (no line items — body has none). */
  parsed: ParsedBill;
  /** The "securely download" link, kept so the user can fetch the PDF later. */
  secureLink?: string;
}

/** Decode the handful of HTML entities Dulux's template leaves in. Two
 *  passes so double-encoded sequences collapse fully. */
function decodeEntities(input: string): string {
  let out = input;
  for (let pass = 0; pass < 2; pass++) {
    out = out
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/gi, "'");
  }
  return out;
}

/**
 * Build a line-structured plaintext view of the email. We combine the
 * plain part (if any) with an HTML→text rendering, because the labelled
 * fields ("Invoice No:", "Amount:", …) sit on their own lines once <br>
 * tags become newlines — which is what lets us match each field to the end
 * of its line without greedily swallowing the next one.
 */
function toText(input: { plain?: string; html?: string }): string {
  const parts: string[] = [];
  if (input.plain && input.plain.trim()) parts.push(input.plain);
  if (input.html && input.html.trim()) {
    const fromHtml = input.html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|td|li|h[1-6]|table)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t ]+/g, ' ');
    parts.push(fromHtml);
  }
  return decodeEntities(parts.join('\n'));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** First "securely download" / tracking link on the Dulux sending domain. */
function extractSecureLink(input: { plain?: string; html?: string }): string | undefined {
  const haystack = `${input.html ?? ''}\n${input.plain ?? ''}`;
  const re = /https:\/\/[^\s"'<>)]*duluxgroup\.com\.au[^\s"'<>)]*/gi;
  const m = re.exec(haystack);
  if (!m) return undefined;
  let url = m[0];
  while (url.length > 0 && '.,;)]>'.includes(url[url.length - 1])) url = url.slice(0, -1);
  return url;
}

/**
 * Parse a Dulux secure-link invoice email into a ParsedBill. Returns null
 * if this doesn't look like a Dulux invoice email (wrong sender, or the
 * Invoice No / Amount fields aren't present) — the caller then falls back
 * to its normal "needs attention" path, so a non-Dulux text email can
 * never be mis-recorded as a bill.
 */
export function parseDuluxSecureLinkEmail(input: {
  from?: string;
  subject?: string;
  plain?: string;
  html?: string;
}): DuluxBodyParseResult | null {
  const from = (input.from ?? '').toLowerCase();
  const subject = input.subject ?? '';
  const looksDulux = from.includes('dulux') || /dulux/i.test(subject);
  if (!looksDulux) return null;

  const text = toText({ plain: input.plain, html: input.html });

  // Invoice number: prefer the body field, fall back to the subject
  // ("Dulux Invoice 0909398550 for Account ***009").
  const invBody = text.match(/Invoice\s*No\.?\s*:?\s*([0-9]{6,})/i);
  const invSubj = subject.match(/Dulux\s+Invoice\s*#?\s*([0-9]{6,})/i);
  const invoiceNumber = (invBody?.[1] ?? invSubj?.[1])?.trim();

  // Amount (gross, GST-inclusive). Handles "$11.71" and "$1,234.56".
  const amtMatch = text.match(/Amount\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  const totalInclGst = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : undefined;

  // Require the two load-bearing fields; otherwise this isn't a parseable
  // Dulux invoice email and we bail to the caller's fallback.
  if (!invoiceNumber || totalInclGst === undefined || !Number.isFinite(totalInclGst)) {
    return null;
  }

  // Issue date: "03/06/2026" (DD/MM/YYYY) → ISO.
  let invoiceDate: string | undefined;
  const dateMatch = text.match(/Date\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    invoiceDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // PO → job hint (the line is its own line thanks to <br>→\n). e.g.
  // "PO: CROMWELL RACETRACK".
  let jobHint: string | undefined;
  const poMatch = text.match(/^\s*PO\s*:?\s*(.+?)\s*$/im);
  if (poMatch) {
    const po = poMatch[1].trim();
    // Guard against the value running into the next sentence if a provider
    // ever flattens the line breaks.
    jobHint = po.split(/\s{2,}|\bClick\b|\bKind regards\b/i)[0].trim() || undefined;
  }

  // GST split. NZ GST is 15% → the GST portion of a GST-inclusive total is
  // total × 3 ÷ 23 (matches the PDF parser's convention).
  const gstComponent = round2(totalInclGst * 3 / 23);
  const amountExGst = round2(totalInclGst - gstComponent);

  const parsed: ParsedBill = {
    supplier: 'Dulux New Zealand',
    invoiceNumber,
    totalInclGst,
    gstComponent,
    amountExGst,
    invoiceDate,
    jobHint,
    // Medium: the figures are explicit and reliable, but there's no PDF to
    // cross-check and no line items, so the UI should still invite a glance.
    confidence: 'medium',
  };

  return { parsed, secureLink: extractSecureLink({ plain: input.plain, html: input.html }) };
}
