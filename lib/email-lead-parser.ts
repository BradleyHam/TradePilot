// Email lead parser — used by the /api/webhooks/inbound-email-lead route
// when Brad forwards a customer enquiry that didn't come through the website
// contact form or Tapi (e.g. someone emails him directly, a referral he
// forwards on, or a lead-notification from another platform).
//
// Why an LLM here when the Tapi parser is deliberately LLM-free:
//   - Tapi emails have ONE rigid machine-generated format, so string ops are
//     more reliable + free. See lib/tapi-lead-parser.ts.
//   - A forwarded human email has NO consistent format. It could be a few
//     words ("can you quote my fence?"), a long ramble, a referral pasted in,
//     or a third-party platform's notification. Worse, Gmail forwarding
//     buries the REAL enquirer's name/email/phone inside the body and puts
//     Brad's own address on the envelope. An LLM untangles all of that
//     trivially; a regex would be brittle. This mirrors the inbound-bill
//     pipeline, which already uses the model to read messy supplier emails.
//
// Design rule (matches the "nothing silently disappears" principle in the
// inbound-bill route): when the model is unsure whether something is a lead,
// it errs towards YES. A missed enquiry is a lost customer = real money; a
// junk lead costs Brad two seconds to delete. We only skip when the model is
// confident it is NOT a customer enquiry (newsletter, receipt, supplier
// invoice, automated notice, spam).

import Anthropic from '@anthropic-ai/sdk';
import type { Tool, MessageParam } from '@anthropic-ai/sdk/resources/messages';

/** Hard cap on characters fed to the model. Forwarded threads can be huge;
 *  the useful enquiry is almost always near the top. Keeps token cost +
 *  latency sane and stays well within the model context. */
export const MAX_EMAIL_LEAD_TEXT_CHARS = 40_000;

/** Raw, validated-but-not-yet-composed fields the model extracts. All
 *  optional except the two routing flags — any field the model can't find on
 *  the email is omitted rather than guessed. */
export interface ParsedEmailLead {
  /** The prospective customer's name (NOT Brad, who forwarded it). */
  contactName?: string;
  /** The customer's email address, pulled from the body of the forward. */
  contactEmail?: string;
  /** The customer's phone number, digits as written. */
  contactPhone?: string;
  /** Property / job address or town the work is at. */
  location?: string;
  /** Short job type, e.g. "Interior repaint", "Roof painting", "Wallpaper". */
  jobType?: string;
  /** A tidy one-line summary suitable for a job title (<= ~80 chars). */
  summary?: string;
  /** The enquirer's actual request, cleaned of forwarding cruft + signatures. */
  message?: string;
  /** False ONLY when the model is confident this is not a customer enquiry. */
  looksLikeLead: boolean;
  /** Coarse confidence in the extraction; 'low' adds a double-check note. */
  confidence: 'high' | 'medium' | 'low';
}

/** Composed lead fields ready to insert as a job row. Shapes match the
 *  columns the inbound-tapi-lead + website-enquiry routes write. */
export interface EmailLeadFields {
  name: string;
  clientName: string;
  clientEmail?: string;
  clientPhone?: string;
  location?: string;
  notes: string;
}

const EMIT_TOOL: Tool = {
  name: 'emit_lead',
  description:
    'Emit the structured fields extracted from a forwarded customer enquiry ' +
    'email for a New Zealand painting business. Omit any field not present ' +
    'in the email rather than guessing.',
  input_schema: {
    type: 'object',
    properties: {
      contactName: {
        type: 'string',
        description:
          "The prospective CUSTOMER's name — the person who wants painting " +
          'done. NOT the painter/business owner who forwarded the email. If ' +
          'only a business or agency name is present, use that.',
      },
      contactEmail: {
        type: 'string',
        description:
          "The customer's email address as printed in the email body. Do " +
          "NOT return the painter's own address or a no-reply/platform " +
          'address unless it is genuinely the only way to reach the lead.',
      },
      contactPhone: {
        type: 'string',
        description: "The customer's phone number, digits as written.",
      },
      location: {
        type: 'string',
        description:
          'The address, suburb, or town where the work is needed, if stated.',
      },
      jobType: {
        type: 'string',
        description:
          'Short description of the work, e.g. "Interior repaint", "Roof ' +
          'painting", "Exterior + deck", "Wallpaper removal". Keep it a few ' +
          'words.',
      },
      summary: {
        type: 'string',
        description:
          'A tidy one-line title for this lead, max ~80 chars. Prefer ' +
          '"{job type} — {short address or suburb}". Example: "Exterior ' +
          'repaint — 12 Aubrey Road, Wanaka".',
      },
      message: {
        type: 'string',
        description:
          "The customer's actual request in their own words, cleaned of " +
          'forwarding headers ("---------- Forwarded message ----------"), ' +
          'quoted reply chains, and email signatures. Keep it readable.',
      },
      looksLikeLead: {
        type: 'boolean',
        description:
          'TRUE if this email could plausibly be a customer wanting a quote ' +
          'or painting work. FALSE only when you are confident it is NOT — ' +
          'e.g. a newsletter, marketing blast, receipt, supplier invoice, ' +
          'automated system notification, or spam. When genuinely unsure, ' +
          'return TRUE: a missed enquiry is a lost customer, a junk lead is ' +
          'trivial to delete.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          "How confident you are in the extracted fields. 'high' = a clear " +
          "enquiry with obvious details. 'medium' = some inference. 'low' = " +
          'significant guesswork or very little to go on.',
      },
    },
    required: ['looksLikeLead', 'confidence'],
  },
};

const SYSTEM_PROMPT = [
  'You read emails that a New Zealand painter (Lakeside Painting) has',
  'FORWARDED to his job tracker because he thinks they might be a new',
  'customer enquiry — a "lead". Your job is to extract the prospective',
  "customer's details and call the emit_lead tool.",
  '',
  'CRITICAL — this is a FORWARDED email. The envelope/From you see is often',
  "the painter's own inbox, and Gmail prepends a forwarding banner. The REAL",
  "lead's name, email, and phone are inside the message body / quoted",
  'original. Extract the CUSTOMER, never the painter who forwarded it.',
  '',
  'Omit any field that is not actually present — do NOT invent a name, email,',
  'phone, or address. Missing data is recoverable when the painter opens the',
  'original; wrong data is not.',
  '',
  'Bias the looksLikeLead flag towards TRUE. Only set it FALSE when you are',
  'genuinely confident the email is not a customer enquiry (newsletter,',
  'marketing, receipt, supplier invoice, automated notification, spam).',
].join('\n');

/**
 * Run the LLM lead parser over a forwarded email.
 *
 * Throws on: missing ANTHROPIC_API_KEY, empty input, or an upstream API
 * failure that survives retries. The route translates throws into a safe
 * fallback lead (we never want a parser hiccup to silently swallow a real
 * customer) — see app/api/webhooks/inbound-email-lead/route.ts.
 */
export async function parseEmailLead(input: {
  subject?: string;
  plain?: string;
  html?: string;
  from?: string;
}): Promise<ParsedEmailLead> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const text = buildSourceText(input);
  if (text.trim().length === 0) throw new Error('Cannot parse empty email');

  const client = new Anthropic({ apiKey });
  const response = await callWithRetry(client, [
    {
      role: 'user',
      content:
        'A forwarded email is below. Extract the prospective customer and ' +
        'call emit_lead.\n\n--- BEGIN EMAIL ---\n' +
        text +
        '\n--- END EMAIL ---',
    },
  ]);

  return normaliseParsedLead(extractEmitted(response));
}

/** Compose the text we hand the model: subject line first (it often carries
 *  the address/job type), then the plaintext body, falling back to a crude
 *  HTML strip when there's no plaintext part. Capped at the char limit. */
function buildSourceText(input: {
  subject?: string;
  plain?: string;
  html?: string;
  from?: string;
}): string {
  const parts: string[] = [];
  if (input.from) parts.push(`From (envelope): ${input.from}`);
  if (input.subject) parts.push(`Subject: ${input.subject}`);
  parts.push('');
  const body = input.plain?.trim()
    ? input.plain
    : input.html
      ? stripHtml(input.html)
      : '';
  parts.push(body);
  const joined = parts.join('\n');
  return joined.length > MAX_EMAIL_LEAD_TEXT_CHARS
    ? joined.slice(0, MAX_EMAIL_LEAD_TEXT_CHARS)
    : joined;
}

/** Minimal HTML → text. Good enough to feed the model when an email has no
 *  text/plain part; we're not trying to render, just to expose the words. */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Call Anthropic with exponential backoff on transient (5xx / 429) failures.
 * Same policy + delays as the bill parser; duplicated rather than shared so
 * the two parsers stay independent modules (matching the bill/tapi split).
 */
async function callWithRetry(
  client: Anthropic,
  messages: MessageParam[],
): Promise<Anthropic.Message> {
  const delays = [1_000, 3_000, 9_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [EMIT_TOOL],
        tool_choice: { type: 'tool', name: 'emit_lead' },
        messages,
      });
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const isRetryable =
        status === 529 || status === 503 || status === 502 || status === 429;
      if (!isRetryable || attempt >= delays.length) throw err;
      const delayMs = delays[attempt];
      console.warn(
        `[email-lead-parser] Anthropic ${status} on attempt ${attempt + 1}; retrying in ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error('Retry loop exhausted unexpectedly');
}

/** Pull the emit_lead tool input out of the response. tool_choice forces it,
 *  but we defend anyway. */
function extractEmitted(response: Anthropic.Message): Record<string, unknown> {
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'emit_lead') {
      if (typeof block.input === 'object' && block.input !== null) {
        return block.input as Record<string, unknown>;
      }
    }
  }
  throw new Error('Parser returned no structured output');
}

/** Validate + coerce raw tool output. Exported so a future re-processing
 *  script or unit test can exercise it without a live API call. */
export function normaliseParsedLead(raw: Record<string, unknown>): ParsedEmailLead {
  const parsed: ParsedEmailLead = {
    // Default to TRUE: only an explicit boolean false suppresses the lead.
    looksLikeLead: raw.looksLikeLead === false ? false : true,
    confidence:
      raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
        ? raw.confidence
        : 'low',
  };

  const str = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };

  parsed.contactName = str(raw.contactName);
  parsed.location = str(raw.location);
  parsed.jobType = str(raw.jobType);
  parsed.summary = str(raw.summary);
  parsed.message = str(raw.message);

  // Only accept an email that actually looks like one.
  const email = str(raw.contactEmail);
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) parsed.contactEmail = email;

  // Only accept a phone with enough digits to dial.
  const phone = str(raw.contactPhone);
  if (phone && (phone.match(/\d/g)?.length ?? 0) >= 6) parsed.contactPhone = phone;

  return parsed;
}

/**
 * Compose insert-ready lead fields from the parsed email. Fallback ladders
 * mirror the website-enquiry route so a thin enquiry still produces a sane,
 * non-empty job name + client name (client_name is NOT NULL in the schema).
 */
export function buildEmailLeadFields(
  p: ParsedEmailLead,
  ctx: { fromHeader?: string; subject?: string } = {},
): EmailLeadFields {
  // ── name ────────────────────────────────────────────────────────────────
  let name: string;
  const summary = p.summary?.trim();
  if (summary && summary.length >= 4 && summary.length <= 80) {
    name = summary;
  } else {
    const loc = shortLocation(p.location);
    if (p.jobType && loc) name = `${p.jobType} — ${loc}`;
    else if (p.jobType) name = p.jobType;
    else if (p.contactName) name = `Email lead — ${p.contactName}`;
    else name = 'Email lead';
  }

  // ── clientName (must be non-empty for the NOT NULL column) ────────────────
  const clientName = p.contactName ?? deriveNameFromHeader(ctx.fromHeader) ?? 'Email enquiry';

  // ── notes ─────────────────────────────────────────────────────────────────
  const notesParts: string[] = [];
  notesParts.push(
    p.message?.trim() ||
      'Forwarded email enquiry — no clear message body parsed. Open the original email to follow up.',
  );

  const who: string[] = [];
  if (p.contactName) who.push(p.contactName);
  if (p.contactEmail) who.push(p.contactEmail);
  if (p.contactPhone) who.push(p.contactPhone);
  if (who.length > 0) notesParts.push(`\n\nLead contact: ${who.join(' · ')}`);

  if (ctx.subject) notesParts.push(`\nEmail subject: ${ctx.subject}`);

  // Show who forwarded it only when it isn't already the captured lead email.
  const fromHeader = ctx.fromHeader?.trim();
  if (fromHeader && !(p.contactEmail && fromHeader.toLowerCase().includes(p.contactEmail.toLowerCase()))) {
    notesParts.push(`\nForwarded via: ${fromHeader}`);
  }

  notesParts.push('\n\n— Auto-created from a forwarded email lead.');
  if (p.confidence === 'low') {
    notesParts.push(' ⚠ Low parse confidence — double-check the details against the original email.');
  }

  return {
    name,
    clientName,
    clientEmail: p.contactEmail,
    clientPhone: p.contactPhone,
    location: p.location,
    notes: notesParts.join(''),
  };
}

/** First comma-chunk of an address (drops the country/long tail), capped. */
function shortLocation(loc?: string): string | undefined {
  if (!loc) return undefined;
  const first = loc.split(',')[0].trim();
  const out = first.length > 0 ? first : loc.trim();
  return out.length > 48 ? `${out.slice(0, 47)}…` : out;
}

/** Pull a display name out of a "Jane Doe <jane@x.com>" From header. */
function deriveNameFromHeader(fromHeader?: string): string | undefined {
  if (!fromHeader) return undefined;
  const m = fromHeader.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  const name = m?.[1]?.trim();
  if (name && name.length > 0 && !name.includes('@')) return name;
  return undefined;
}

/** Normalise a string for content-based dedup. Identical to the helper in
 *  lib/tapi-lead-parser.ts; kept local so the modules stay independent. */
export function normaliseForDedup(s?: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
