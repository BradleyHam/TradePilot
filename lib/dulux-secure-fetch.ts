// lib/dulux-secure-fetch.ts
//
// Server-side resolver for Dulux's "secure link" invoice PDFs.
//
// Background: since ~May 2026 Dulux NZ emails invoices as a "click here to
// securely download" link instead of a PDF attachment. That link lands on a
// JS page that asks for the customer's account number before releasing the
// PDF. The generic link-follower (lib/bill-link-follower.ts) can't get past
// it because it only follows a URL and expects an immediate PDF.
//
// But the gate is NOT a real challenge — there's no captcha, no login, no JS
// puzzle. Reverse-engineered from the live page (June 2026), the flow is a
// plain two-request exchange:
//
//   1. GET https://e.duluxgroup.com.au/t/s/<shortcode>
//        → 200 text/html, and a Set-Cookie: drsToken_DULUX_Z5=<json>
//          The cookie value is (double-)URL-encoded JSON that contains a
//          long "TOKENV2…" document token (~366 url-safe chars).
//
//   2. GET https://e.duluxgroup.com.au/securelink-srv/documentV5/<TOKEN>/<ACCOUNT_NUMBER>
//        → 200 application/pdf — the actual invoice, line items and all.
//
// The documentV5 endpoint authenticates purely on the path (token + account
// number) — it returns the PDF even with cookies omitted. The account number
// is the customer's Dulux customer number (printed on every invoice, e.g.
// 146009 for Lakeside), supplied via the DULUX_ACCOUNT_NUMBER env var. The
// token is single-purpose (one invoice) and lives for weeks.
//
// Safety: this only ever fetches the business's OWN invoices from its OWN
// supplier account, and only for short links on the already-allowlisted
// e.duluxgroup.com.au host. If anything about the exchange changes (Dulux
// adds a real captcha, rotates the cookie name, etc.) every step fails
// closed and the caller falls back to the email-body parser — so a failure
// here can never mis-record a bill, only miss the line items.

const SHORT_LINK_HOST = 'e.duluxgroup.com.au';
const DOC_ENDPOINT = 'https://e.duluxgroup.com.au/securelink-srv/documentV5';
const COOKIE_NAME = 'drsToken_DULUX_Z5';
const TOKEN_RE = /TOKENV2[A-Za-z0-9_-]+/;

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB, matches the route's cap
const FETCH_TIMEOUT_MS = 15_000;

export interface DuluxFetchResult {
  /** PDF bytes on success. */
  pdf?: Buffer;
  /** The document URL we ended up fetching (token-redacted) — for logs. */
  finalUrl?: string;
  reason?:
    | 'no-account-number' // DULUX_ACCOUNT_NUMBER not configured
    | 'no-short-link' // no e.duluxgroup.com.au /t/s/ link in the email
    | 'no-token-cookie' // short link didn't set the expected token cookie
    | 'token-not-found' // cookie present but no TOKENV2 token inside it
    | 'fetch-failed'
    | 'wrong-content-type' // document endpoint returned non-PDF (gate changed / bad account)
    | 'too-large'
    | 'empty-response'
    | 'timeout';
  detail?: string;
}

/**
 * Find the first Dulux secure short link in an email body. These look like
 * https://e.duluxgroup.com.au/t/s/<shortcode>. Tracking/analytics links on
 * other Dulux domains are ignored — only the /t/s/ short link sets the
 * document token.
 */
export function extractDuluxShortLink(body: { plain?: string; html?: string }): string | undefined {
  const haystack = `${body.html ?? ''}\n${body.plain ?? ''}`;
  const re = /https:\/\/e\.duluxgroup\.com\.au\/t\/s\/[A-Za-z0-9]+/gi;
  const m = re.exec(haystack);
  if (!m) return undefined;
  return m[0];
}

/** Pull the TOKENV2… document token out of the Set-Cookie header(s). */
function tokenFromSetCookie(setCookies: string[]): string | undefined {
  for (const c of setCookies) {
    // Each entry is "name=value; Path=/; ...". We only care about ours.
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    const name = c.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const value = c.slice(eq + 1).split(';')[0];
    // The value is (often double-) URL-encoded JSON; decode best-effort,
    // then regex the token out regardless of the JSON shape.
    let decoded = value;
    for (let pass = 0; pass < 2; pass++) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    const tm = decoded.match(TOKEN_RE) ?? value.match(TOKEN_RE);
    if (tm) return tm[0];
  }
  return undefined;
}

/** Redact a TOKENV2 token from a URL for safe logging. */
function redact(url: string): string {
  return url.replace(/TOKENV2[A-Za-z0-9_-]+/g, 'TOKEN<redacted>');
}

/**
 * Resolve a Dulux secure short link to the invoice PDF, gated by the
 * configured account number. Never throws — all failures map to `reason`.
 *
 *   shortLink      the https://e.duluxgroup.com.au/t/s/<code> link from the email
 *   accountNumber  the Dulux customer number (DULUX_ACCOUNT_NUMBER)
 */
export async function fetchDuluxSecurePdf(
  shortLink: string,
  accountNumber: string,
): Promise<DuluxFetchResult> {
  if (!accountNumber) return { reason: 'no-account-number' };
  // Defensive: only follow links on the expected host.
  try {
    const u = new URL(shortLink);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== SHORT_LINK_HOST) {
      return { reason: 'no-short-link', detail: `Unexpected host ${u.hostname}` };
    }
  } catch {
    return { reason: 'no-short-link', detail: 'Unparseable short link' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Step 1: resolve the short link and capture the token cookie. The short
    // link 30x-redirects to the SPA, and the token cookie is set on one of
    // the redirect hops. fetch(redirect:'follow') only exposes the FINAL
    // response's headers, so it would miss a cookie set on an intermediate
    // hop. We follow redirects manually instead, accumulating Set-Cookie
    // from every hop until we find the token (or run out of hops).
    const collectedCookies: string[] = [];
    let url = shortLink;
    let lastStatus = 0;
    for (let hop = 0; hop < 5; hop++) {
      const r: Response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'TradePilot-InboundBill/1.0 (+bills@tradepilot.co.nz)',
          Accept: 'text/html,*/*;q=0.8',
        },
      });
      lastStatus = r.status;
      const setCookies: string[] =
        typeof r.headers.getSetCookie === 'function'
          ? r.headers.getSetCookie()
          : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie') as string] : []);
      collectedCookies.push(...setCookies);
      // Stop as soon as we have the token.
      if (tokenFromSetCookie(collectedCookies)) break;
      // Otherwise follow the redirect, if there is one.
      const isRedirect = r.status >= 300 && r.status < 400;
      const loc = r.headers.get('location');
      if (!isRedirect || !loc) break;
      url = new URL(loc, url).toString();
    }
    if (collectedCookies.length === 0) {
      return { reason: 'no-token-cookie', detail: `Short link returned ${lastStatus} with no Set-Cookie` };
    }
    const token = tokenFromSetCookie(collectedCookies);
    if (!token) return { reason: 'token-not-found' };

    // Step 2: fetch the document. The endpoint authenticates on the path
    // (token + account number); no cookie needed.
    const docUrl = `${DOC_ENDPOINT}/${token}/${encodeURIComponent(accountNumber)}`;
    const r2 = await fetch(docUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'TradePilot-InboundBill/1.0 (+bills@tradepilot.co.nz)',
        Accept: 'application/pdf,*/*;q=0.8',
      },
    });
    if (!r2.ok) {
      return { reason: 'fetch-failed', detail: `HTTP ${r2.status} ${r2.statusText}`, finalUrl: redact(docUrl) };
    }
    const ct = r2.headers.get('content-type')?.toLowerCase() ?? '';
    if (!ct.includes('application/pdf')) {
      // Usually means the account number didn't match the link, or Dulux
      // changed the gate. Caller falls back to the body parser.
      return { reason: 'wrong-content-type', detail: `Got content-type "${ct}"`, finalUrl: redact(docUrl) };
    }

    // Stream with a size cap so a runaway response can't exhaust memory.
    const reader = r2.body?.getReader();
    if (!reader) return { reason: 'empty-response', finalUrl: redact(docUrl) };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_PDF_BYTES) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return { reason: 'too-large', detail: `PDF exceeded ${MAX_PDF_BYTES} bytes`, finalUrl: redact(docUrl) };
        }
        chunks.push(value);
      }
    }
    const pdf = Buffer.concat(chunks);
    if (pdf.length === 0) return { reason: 'empty-response', finalUrl: redact(docUrl) };
    return { pdf, finalUrl: redact(docUrl) };
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
