// Link-following fallback for the inbound-bill webhook.
//
// Some suppliers (Dulux as of May 2026) have moved from PDF-attached
// invoice emails to "click here to securely download" link-style emails.
// CloudMailin still delivers the email, but `attachments` is empty —
// the route's old "no PDF attachment → skipped" branch silently dropped
// these bills.
//
// This module scans the email body for known supplier download URLs,
// fetches the first match server-side, and returns the PDF bytes so the
// existing parser pipeline can take over.
//
// Safety constraints:
//   - Hard URL allowlist (host-suffix match). We do NOT follow arbitrary
//     links from email bodies — email is an untrusted source and a
//     malicious sender could point us at malware or SSRF targets.
//   - Size cap (matches the manual-upload route).
//   - 15-second timeout. Supplier portals are usually <2s; anything
//     slower than 15s is almost certainly an auth wall or dead link.
//   - Follows redirects (suppliers commonly redirect through tracking
//     domains) but the FINAL response must be application/pdf.
//   - Only HTTPS. No http:// downloads.
//
// Adding a new supplier means appending one line to ALLOWED_HOSTS.

/** Host suffixes we will follow links to. Match is case-insensitive
 *  and suffix-based — e.g. `dulux.co.nz` matches `secure.dulux.co.nz`
 *  but not `evil.com/?dulux.co.nz`.
 *
 *  Keep this list narrow. Every entry is a trust decision: we're saying
 *  "if a forwarded email contains a URL pointing here, we will fetch
 *  it with no user confirmation". */
export const ALLOWED_HOSTS: ReadonlyArray<string> = [
  'dulux.co.nz',
  'duluxgroup.com.au',
  'e.duluxgroup.com.au', // the noreply.duluxnz@e.duluxgroup.com.au sender's tracking domain
];

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB, matches the route's existing cap
const FETCH_TIMEOUT_MS = 15_000;

export interface LinkFollowResult {
  /** PDF bytes if we successfully fetched one. */
  pdf?: Buffer;
  /** The URL we ended up fetching (after redirects). Useful for logging. */
  finalUrl?: string;
  /** Set when fetch failed or no allowlisted URL was present. */
  reason?:
    | 'no-allowlisted-url'
    | 'fetch-failed'
    | 'wrong-content-type'
    | 'too-large'
    | 'empty-response'
    | 'timeout';
  /** Extra context for logs / parser-raw. */
  detail?: string;
}

/**
 * Extract every plausible URL from a string. Handles common cases —
 * bare `https://...`, anchor `href="..."`, and Outlook's URL-rewriter
 * wrapping. We're deliberately liberal about extraction because the
 * allowlist is the safety net, not the regex.
 */
function extractUrls(text: string): string[] {
  if (!text) return [];
  const urls = new Set<string>();
  // Bare URLs and URLs inside href="..."/href='...' attributes.
  // We require https:// — no http://, no protocol-relative.
  const re = /https:\/\/[^\s"'<>)]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Strip trailing punctuation that's almost certainly not part of
    // the URL: ".", ",", ")", "]", ";". Common in email body prose.
    let url = m[0];
    while (url.length > 0 && '.,;)]>'.includes(url[url.length - 1])) {
      url = url.slice(0, -1);
    }
    urls.add(url);
  }
  return Array.from(urls);
}

/** Suffix-match a URL's host against the allowlist. */
function isAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * Scan an email body for the first allowlisted PDF download link and
 * fetch it. Returns the PDF bytes on success or a reason string on
 * failure. Never throws — all errors are mapped to `reason`.
 */
export async function followBillDownloadLink(
  emailBody: { plain?: string; html?: string },
): Promise<LinkFollowResult> {
  // Scan both plain and html for URLs. Some suppliers send only one or
  // the other; doing both costs nothing.
  const candidates = [
    ...extractUrls(emailBody.plain ?? ''),
    ...extractUrls(emailBody.html ?? ''),
  ].filter(isAllowed);

  if (candidates.length === 0) {
    return { reason: 'no-allowlisted-url' };
  }

  // Try candidates in order. Stop at the first one that returns a PDF.
  // Most emails have a single download link; the loop is defensive in
  // case Dulux adds tracking link + content link as two separate URLs.
  for (const url of candidates) {
    const result = await fetchOnePdf(url);
    if (result.pdf) return result;
    // Keep trying other candidates if we got a non-PDF (e.g. the first
    // link was an unsubscribe URL).
  }

  // None of the allowlisted URLs returned a PDF.
  return {
    reason: 'wrong-content-type',
    detail: `Tried ${candidates.length} allowlisted URL${candidates.length === 1 ? '' : 's'}, none returned a PDF.`,
  };
}

async function fetchOnePdf(url: string): Promise<LinkFollowResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some supplier portals return HTML to non-browser UAs and the
        // actual PDF to browsers. Identify as a generic browser to dodge
        // that quirk without lying about who we are.
        'User-Agent': 'TradePilot-InboundBill/1.0 (+bills@tradepilot.co.nz)',
        'Accept': 'application/pdf,*/*;q=0.8',
      },
    });

    if (!res.ok) {
      return {
        reason: 'fetch-failed',
        detail: `HTTP ${res.status} ${res.statusText}`,
        finalUrl: res.url,
      };
    }

    const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/pdf')) {
      return {
        reason: 'wrong-content-type',
        detail: `Got content-type "${contentType}" (expected application/pdf)`,
        finalUrl: res.url,
      };
    }

    // Use a streamed read so we can enforce the size cap without
    // pulling a malicious 1GB response into memory.
    const reader = res.body?.getReader();
    if (!reader) {
      return { reason: 'empty-response', finalUrl: res.url };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_PDF_BYTES) {
          // Drain + cancel — don't leak the connection.
          try { await reader.cancel(); } catch { /* ignore */ }
          return {
            reason: 'too-large',
            detail: `PDF exceeded ${MAX_PDF_BYTES} bytes`,
            finalUrl: res.url,
          };
        }
        chunks.push(value);
      }
    }

    const pdf = Buffer.concat(chunks);
    if (pdf.length === 0) {
      return { reason: 'empty-response', finalUrl: res.url };
    }
    return { pdf, finalUrl: res.url };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      reason: isAbort ? 'timeout' : 'fetch-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
