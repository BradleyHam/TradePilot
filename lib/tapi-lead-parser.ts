// lib/tapi-lead-parser.ts
//
// Parses Tapi "Provide a quote" notification emails (sent from
// hi@tapihq.com when a property manager asks Lakeside to quote a job) into
// the fields we need to create a lead. Pure + dependency-free so it's
// cheap, deterministic, and unit-testable — no LLM call, because the email
// format is consistent enough to parse with string ops.
//
// A Tapi quote-request email's PLAINTEXT body looks like this (entities are
// NOT decoded in Tapi's plaintext part — "Home &amp; Co" comes through
// literally, which is why we decode below):
//
//   ~~~ Provide a quote ~~~
//   Hi Lakeside Painting,
//   Colleen has requested a quote for this job:
//   Interior Re-paint
//   41 Faulks Terrace
//   Message from Colleen:
//   <free-text message, one or more lines>
//   Please provide a quote for this job through this online form:
//   View full job ... open this link:
//   https://url6277.tapihq.com/ls/click?...
//   Regards,
//   Home & Co
//   ~~~ Powered by Tapi. ...
//
// The SUBJECT is "Provide a quote for {address}" and is the most reliable
// source of the full address (it includes the suburb, e.g. "..., Wanaka").
//
// Other Tapi mail types ("Quote accepted ...", "New work order ...",
// "Quote declined ...", "Please confirm work ...") must NOT be treated as
// quote requests — isTapiQuoteRequest() guards against them so the webhook
// only ever creates a lead from a genuine request.

export interface TapiQuoteRequest {
  /** e.g. "Interior Re-paint" — the job title line from the body. */
  jobType?: string;
  /** Full address incl. suburb, preferred from the subject. e.g. "41 Faulks Terrace, Wanaka". */
  address?: string;
  /** Short address from the body (no suburb). e.g. "41 Faulks Terrace". */
  addressShort?: string;
  /** The requesting property manager's name. e.g. "Colleen". */
  propertyManager?: string;
  /** The property-management company from the sign-off. e.g. "Home & Co". */
  agency?: string;
  /** The PM's free-text message to Brad. */
  message?: string;
  /** The "View full job & enter quote" deep link back into Tapi. */
  tapiLink?: string;
}

export interface TapiLeadFields {
  name: string;
  clientName: string;
  location?: string;
  notes: string;
}

/**
 * Decode the handful of HTML entities Tapi leaves in its plaintext part.
 * Two passes so double-encoded sequences (e.g. "&amp;amp;" → "&amp;" → "&")
 * collapse fully.
 */
function decodeEntities(input: string): string {
  let out = input;
  for (let pass = 0; pass < 2; pass++) {
    out = out
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
  return out;
}

/**
 * Get a plaintext view of the email. Prefer the real plaintext part; fall
 * back to a crude tag-strip of the HTML so detection still works if a
 * provider only sends HTML. Field extraction is line-structured and so
 * relies on the plaintext part in practice (CloudMailin always sends it).
 */
function toText(input: { plain?: string; html?: string }): string {
  if (input.plain && input.plain.trim()) return input.plain;
  if (input.html) {
    return input.html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ');
  }
  return '';
}

/**
 * Is this email a Tapi "Provide a quote" request we should turn into a
 * lead? Precise on purpose: it matches the request subject/body markers
 * and deliberately does NOT match "Quote accepted/declined", "New work
 * order", or "Please confirm work" emails (all of which also mention
 * "quote" but are not requests). Used as a guard in the webhook so a broad
 * Gmail forward rule can't create junk leads.
 */
export function isTapiQuoteRequest(input: {
  from?: string;
  subject?: string;
  plain?: string;
  html?: string;
}): boolean {
  const subject = (input.subject ?? '').toLowerCase();
  const body = decodeEntities(toText({ plain: input.plain, html: input.html })).toLowerCase();

  // "Provide a quote for {address}" is the canonical request subject.
  const subjectMatch = /provide a quote for\b/.test(subject);
  // Body markers: the "Provide a quote" header AND the request sentence.
  const bodyMatch =
    /provide a quote\b/.test(body) && /requested a quote for this job/.test(body);

  return subjectMatch || bodyMatch;
}

/**
 * Parse the structured fields out of a Tapi quote-request email.
 * Best-effort — every field is optional. Callers should still create a
 * lead even if most fields come back undefined (better a sparse lead than
 * a dropped one).
 */
export function parseTapiQuoteEmail(input: {
  subject?: string;
  plain?: string;
  html?: string;
}): TapiQuoteRequest {
  const text = decodeEntities(toText({ plain: input.plain, html: input.html }));
  const subject = decodeEntities(input.subject ?? '').trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // ── Address (full) from the subject: "Provide a quote for 41 Faulks Terrace, Wanaka"
  let address: string | undefined;
  const subjMatch = subject.match(/provide a quote for\s+(.+)$/i);
  if (subjMatch) address = subjMatch[1].trim().replace(/[\s.]+$/, '') || undefined;

  // ── Job block: the lines between "...requested a quote for this job:" and
  //    "Message from ...". First non-empty line = job type, second = short address.
  let jobType: string | undefined;
  let addressShort: string | undefined;
  const reqIdx = lines.findIndex((l) => /requested a quote for this job:/i.test(l));
  const msgFromIdx = lines.findIndex((l) => /^message from\b/i.test(l));
  if (reqIdx !== -1) {
    const end = msgFromIdx !== -1 ? msgFromIdx : lines.length;
    const block = lines.slice(reqIdx + 1, end).filter(Boolean);
    if (block[0]) jobType = block[0];
    if (block[1]) addressShort = block[1];
  }

  // ── Property manager name: "Colleen has requested a quote for this job:"
  let propertyManager: string | undefined;
  const pmReq = text.match(/^[ \t]*(.+?)\s+has requested a quote for this job:/im);
  if (pmReq) propertyManager = pmReq[1].trim();
  if (!propertyManager) {
    const pmMsg = text.match(/^[ \t]*message from\s+(.+?):\s*$/im);
    if (pmMsg) propertyManager = pmMsg[1].trim();
  }

  // ── Message: between "Message from X:" and "Please provide a quote ... online form:"
  let message: string | undefined;
  if (msgFromIdx !== -1) {
    const formIdx = lines.findIndex(
      (l, i) => i > msgFromIdx && /please provide a quote/i.test(l),
    );
    const end = formIdx !== -1 ? formIdx : lines.length;
    message = lines.slice(msgFromIdx + 1, end).join('\n').trim() || undefined;
  }

  // ── Agency: the first non-empty line after "Regards," (before the footer).
  let agency: string | undefined;
  const regardsIdx = lines.findIndex((l) => /^regards,?\s*$/i.test(l));
  if (regardsIdx !== -1) {
    for (let i = regardsIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      if (/powered by tapi/i.test(l) || /^~~~/.test(l)) break;
      agency = l;
      break;
    }
  }

  // ── Tapi deep link: first tapihq URL in the body (strip trailing punctuation).
  let tapiLink: string | undefined;
  const linkMatch = text.match(/https?:\/\/\S*tapihq\.com\/\S+/i);
  if (linkMatch) tapiLink = linkMatch[0].replace(/[)\].,]+$/, '');

  return {
    jobType,
    address: address ?? addressShort,
    addressShort: addressShort ?? address,
    propertyManager,
    agency,
    message,
    tapiLink,
  };
}

/**
 * Compose the lead's display fields from a parsed request.
 *
 *   name        "{jobType} — {short address}", with graceful fallbacks.
 *   clientName  the agency (the recurring PM company is the most useful
 *               thing to see in the list) → PM person → generic label.
 *   location    the full address (incl. suburb where we have it).
 *   notes       the PM's message + who it's from + a tap-through Tapi link.
 */
export function buildTapiLeadFields(p: TapiQuoteRequest): TapiLeadFields {
  const shortAddr = p.addressShort ?? p.address;

  let name: string;
  if (p.jobType && shortAddr) name = `${p.jobType} — ${shortAddr}`;
  else if (p.jobType) name = p.jobType;
  else if (shortAddr) name = `Quote — ${shortAddr}`;
  else name = 'Tapi quote request';

  const clientName = p.agency ?? p.propertyManager ?? 'Property manager (Tapi)';

  const parts: string[] = [];
  if (p.message) parts.push(p.message);
  const who = [p.propertyManager, p.agency].filter(Boolean).join(', ');
  if (who) parts.push(`Property manager: ${who}`);
  parts.push('Source: Tapi quote request');
  if (p.tapiLink) parts.push(`View on Tapi: ${p.tapiLink}`);

  return {
    name,
    clientName,
    location: p.address ?? shortAddr,
    notes: parts.join('\n\n'),
  };
}

/**
 * Loose normalisation for content-based dedup: lowercase, collapse any run
 * of non-alphanumerics to a single space, trim. So "41 Faulks Terrace,
 * Wanaka" and "41 faulks terrace  wanaka" compare equal.
 */
export function normaliseForDedup(s?: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
