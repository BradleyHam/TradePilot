/**
 * Shared webhook-secret comparison for the inbound webhook routes
 * (inbound-bill, inbound-tapi-lead, inbound-email-lead, website-enquiry).
 *
 * `===` string comparison short-circuits on the first differing byte,
 * which in principle leaks how much of a guessed secret matched via
 * response timing. Practical risk over HTTPS + network jitter is low,
 * but constant-time comparison costs nothing — so every route funnels
 * through here instead of comparing inline.
 *
 * Node runtime only (uses node:crypto). All four webhook routes already
 * run on the Node runtime (they use Buffer / pdf parsing / the
 * Anthropic SDK), so that's not a new constraint.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time equality for a presented secret vs the expected one.
 * Returns false (never throws) on null/undefined/empty presented values.
 *
 * Length still leaks (timingSafeEqual requires equal lengths, so unequal
 * lengths return early) — unavoidable without padding, and knowing the
 * secret's length doesn't meaningfully help an attacker guess 32+ random
 * bytes.
 */
export function secretMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The dual auth scheme shared by the three CloudMailin-fed routes:
 *   (a) `x-webhook-secret: <secret>` header, or
 *   (b) HTTP basic auth from a `https://anything:<secret>@host/...` URL —
 *       Node decodes that into `Authorization: Basic base64(anything:<secret>)`.
 *       Username OR password may carry the secret (preserves the behaviour
 *       every live CloudMailin config was set up against), each compared
 *       constant-time. A colon-less credential is matched whole — some
 *       clients omit the username entirely.
 */
export function webhookRequestAuthenticated(req: Request, expected: string): boolean {
  if (secretMatches(req.headers.get('x-webhook-secret'), expected)) return true;

  const basicHeader = req.headers.get('authorization');
  if (basicHeader?.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(basicHeader.slice('basic '.length).trim(), 'base64').toString('utf-8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) return secretMatches(decoded, expected);
      // Both sides evaluated unconditionally (no short-circuit) so the
      // username/password check itself stays constant-shape.
      const userOk = secretMatches(decoded.slice(0, colonIdx), expected);
      const passOk = secretMatches(decoded.slice(colonIdx + 1), expected);
      return userOk || passOk;
    } catch {
      return false;
    }
  }
  return false;
}
