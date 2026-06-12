// Marketing AI — Claude calls that turn a finished job into website copy.
//
// Two jobs:
//   1. generateProjectCopy — improve the short description + write the longer
//      overview paragraphs for a portfolio project page, from the job facts
//      plus whatever draft Brad has typed.
//   2. labelProjectImage — vision: look at a before/after photo and produce an
//      SEO-friendly filename + alt text describing what's actually visible.
//
// Mirrors lib/bill-parser.ts: same SDK, same forced tool_choice for reliable
// structured output, same retry-on-overload wrapper. SERVER-ONLY — imported by
// the /api/marketing routes, never from the browser (it reads ANTHROPIC_API_KEY).

import Anthropic from '@anthropic-ai/sdk';
import type { Tool, MessageParam } from '@anthropic-ai/sdk/resources/messages';

// Same model the bill/invoice parsers use — known-good in this account, cheap,
// and plenty for short marketing copy + photo labelling. Bump in one place.
const MODEL = 'claude-haiku-4-5';

// ── Shared plumbing ─────────────────────────────────────────────────────────

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  return new Anthropic({ apiKey });
}

/**
 * Call Anthropic with a forced tool, retrying transient overload/rate errors
 * (529/503/502/429) with 1s/3s/9s backoff. Same policy as the bill parser.
 */
async function callTool(
  client: Anthropic,
  opts: { system: string; tool: Tool; content: MessageParam['content']; maxTokens?: number },
): Promise<Record<string, unknown>> {
  const delays = [1_000, 3_000, 9_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: opts.maxTokens ?? 1024,
        system: opts.system,
        tools: [opts.tool],
        tool_choice: { type: 'tool', name: opts.tool.name },
        messages: [{ role: 'user', content: opts.content }],
      });
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === opts.tool.name) {
          if (typeof block.input === 'object' && block.input !== null) {
            return block.input as Record<string, unknown>;
          }
        }
      }
      throw new Error('Model returned no structured output');
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const retryable = status === 529 || status === 503 || status === 502 || status === 429;
      if (!retryable || attempt >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr ?? new Error('Retry loop exhausted unexpectedly');
}

// ── Project copy (description + overview) ───────────────────────────────────

export interface ProjectCopyInput {
  jobName: string;
  location?: string;
  /** Human-readable service labels, e.g. ["Exterior Painting", "Cedar Restoration"]. */
  services?: string[];
  /** Free-text scope notes captured at the site visit, if any. */
  scopeNotes?: string;
  /** The stain/paint product if recorded. */
  stainProduct?: string;
  /** Whatever Brad has already typed in the description field. */
  draft?: string;
  beforeCount: number;
  afterCount: number;
}

export interface ProjectCopy {
  /** Short page title, e.g. "Interior Repaint, Cromwell". */
  title: string;
  /** The lead paragraph (1–2 full sentences) — the opening copy on the page. */
  description: string;
  /** 2–4 substantial paragraphs forming the body of the project page. */
  overview: string[];
}

const COPY_TOOL: Tool = {
  name: 'emit_project_copy',
  description: 'Emit polished portfolio copy for a completed painting job.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A short, punchy page title that names the work + location, e.g. "Interior Repaint, Cromwell" or "Cedar Restain, Lake Hawea". Title case, no trailing punctuation.',
      },
      description: {
        type: 'string',
        description: 'The LEAD paragraph: 1–2 full, substantial sentences (about 25–45 words) introducing the project — the property/brief and what was done. This is real page copy, NOT a terse tagline. Mentions the location naturally. No client names.',
      },
      overview: {
        type: 'array',
        items: { type: 'string' },
        description: '2–3 substantial paragraphs (each ~2–4 sentences) forming the body of the page: the brief/challenge, how the work was approached (prep, products, technique), and the result. Keep it tight — quality over quantity, no padding. Do NOT repeat the lead paragraph verbatim. No client names, no invented facts (colours, brands, m²) unless given.',
      },
    },
    required: ['title', 'description', 'overview'],
  },
};

const COPY_SYSTEM = [
  'You write portfolio copy for Lakeside Painting / Painters Wanaka, a small',
  'painting business in Wanaka, Central Otago, New Zealand.',
  'Voice: warm, plain, confident tradesperson — informative, not salesy or flowery.',
  'Write in NZ English (use the macron in "Wānaka" where natural).',
  'This is for a real project-page on the website, so write proper page copy —',
  'a solid lead paragraph plus 2–3 tight body paragraphs — matching the tone of',
  'the examples provided. Keep it concise; no padding. Use the location +',
  'service naturally for SEO.',
  'NEVER invent specifics that are not supported by the inputs (no made-up',
  'colours, brands, square-metres, or client names). If a detail is unknown,',
  'write around it rather than guessing.',
].join('\n');

// Two real project overviews, used purely as voice/length references so the
// generated copy matches the existing site (NOT to copy any facts from).
const STYLE_EXEMPLARS = [
  'EXAMPLE A (cedar restain):',
  'Lead: "This project involved restoring and re-staining exterior cedar cladding on a modern Wānaka home. Over time, the cedar had weathered unevenly, with areas of fading and darkening from sun exposure and alpine conditions."',
  'Body para: "We carefully prepared the timber to ensure an even finish and strong stain penetration, then applied a fresh coat of exterior cedar stain to revive the natural colour and grain of the wood. The result is a richer, more consistent finish that enhances the architectural lines of the home while providing long-term protection against UV and moisture."',
  '',
  'EXAMPLE B (commercial exterior):',
  'Lead: "This project involved exterior painting works for a commercial building in Cromwell. The brief was to deliver a durable, low-maintenance finish that suited the modern design of the building while standing up to Central Otago’s harsh climate."',
  'Body para: "We carried out full surface preparation, including cleaning and keying of existing substrates, followed by the application of high-quality exterior coatings designed for long-term performance. Care was taken around edges, junctions, and architectural details to ensure crisp lines and a consistent finish across all visible elevations."',
].join('\n');

export async function generateProjectCopy(input: ProjectCopyInput): Promise<ProjectCopy> {
  const client = getClient();
  const facts = [
    `Job: ${input.jobName}`,
    input.location ? `Location: ${input.location}` : '',
    input.services && input.services.length ? `Services: ${input.services.join(', ')}` : '',
    input.scopeNotes ? `Scope notes from site visit: ${input.scopeNotes}` : '',
    input.stainProduct ? `Product used: ${input.stainProduct}` : '',
    `Photos available: ${input.beforeCount} before, ${input.afterCount} after`,
    input.draft ? `Brad's draft description (improve on this, keep his meaning): ${input.draft}` : '',
  ].filter(Boolean).join('\n');

  const raw = await callTool(client, {
    system: COPY_SYSTEM,
    tool: COPY_TOOL,
    maxTokens: 1500,
    content:
      'Write the project-page copy for this completed painting job. Match the ' +
      'voice of the examples below: a solid lead paragraph plus 2–3 tight body ' +
      'paragraphs — not short taglines, but no padding either. Call ' +
      'emit_project_copy.\n\n' +
      '=== STYLE EXAMPLES (voice + length only — do not copy facts) ===\n' +
      STYLE_EXEMPLARS +
      '\n\n=== THIS JOB ===\n' + facts,
  });

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const overview = Array.isArray(raw.overview)
    ? raw.overview.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean)
    : [];
  if (!description || overview.length === 0) {
    throw new Error('AI returned empty project copy');
  }
  return { title: title || input.jobName, description, overview };
}

// ── Per-block rewrite ───────────────────────────────────────────────────────

const REWRITE_TOOL: Tool = {
  name: 'emit_rewrite',
  description: 'Emit a rewritten version of a single block of copy.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The rewritten copy. Plain prose, no markdown, no quotes around it.' },
    },
    required: ['text'],
  },
};

const REWRITE_SYSTEM = [
  'You edit copy for Lakeside Painting / Painters Wanaka, a painting business',
  'in Wanaka, Central Otago, NZ. Rewrite the single block of text you are given',
  'according to the instruction, keeping the same factual meaning — never invent',
  'new specifics (colours, brands, m², names). NZ English, warm and plain.',
  'Return ONLY the rewritten block via the tool.',
].join('\n');

/**
 * Rewrite one block of copy (title, lead, or a paragraph) per a short
 * instruction like "make it longer", "more professional", "shorter".
 */
export async function rewriteCopy(input: {
  text: string;
  instruction: string;
  context?: string;
}): Promise<string> {
  const client = getClient();
  const raw = await callTool(client, {
    system: REWRITE_SYSTEM,
    tool: REWRITE_TOOL,
    maxTokens: 800,
    content:
      (input.context ? `Context: ${input.context}\n\n` : '') +
      `Instruction: ${input.instruction}\n\n` +
      `Block to rewrite:\n"""\n${input.text}\n"""`,
  });
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) throw new Error('AI returned an empty rewrite');
  return text;
}

// ── Whole-body rewrite ──────────────────────────────────────────────────────

const BODY_TOOL: Tool = {
  name: 'emit_body',
  description: 'Emit the rewritten lead paragraph + body paragraphs for a project page.',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'The rewritten lead paragraph.' },
      overview: {
        type: 'array',
        items: { type: 'string' },
        description: 'The rewritten body paragraphs. You MAY return fewer paragraphs than the input (merge or drop) when shortening.',
      },
    },
    required: ['description', 'overview'],
  },
};

/**
 * Rewrite the ENTIRE page body (lead + all paragraphs) in one pass, so it can
 * shorten holistically — merging or dropping paragraphs — rather than block by
 * block. Keeps the same facts and voice.
 */
export async function rewriteProjectBody(input: {
  description: string;
  overview: string[];
  instruction: string;
}): Promise<{ description: string; overview: string[] }> {
  const client = getClient();
  const current = [
    `Lead: ${input.description}`,
    ...input.overview.map((p, i) => `Paragraph ${i + 1}: ${p}`),
  ].join('\n\n');

  const raw = await callTool(client, {
    system: COPY_SYSTEM,
    tool: BODY_TOOL,
    maxTokens: 1500,
    content:
      `Instruction: ${input.instruction}\n\n` +
      'Rewrite the whole project-page body below accordingly and call emit_body ' +
      'with a lead paragraph + the body paragraphs. Keep all facts; you may ' +
      'merge or drop paragraphs when shortening.\n\n"""\n' + current + '\n"""',
  });

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const overview = Array.isArray(raw.overview)
    ? raw.overview.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean)
    : [];
  if (!description && overview.length === 0) throw new Error('AI returned empty copy');
  return { description, overview };
}

// ── Facebook post caption ───────────────────────────────────────────────────

export interface FacebookPostInput {
  jobName: string;
  location?: string;
  /** Human-readable service labels, e.g. ["Exterior Painting", "Cedar Restoration"]. */
  services?: string[];
  /** The reviewed website lead paragraph — the main source of truth for facts. */
  description?: string;
  /** The reviewed website overview paragraphs, for extra detail to draw on. */
  overview?: string[];
  /** Free-text scope notes captured at the site visit, if any. */
  scopeNotes?: string;
  /** The stain/paint product if recorded. */
  stainProduct?: string;
  /** Public URL of the live project page, included as a CTA when the site is published. */
  projectUrl?: string;
}

export interface FacebookPost {
  /** The full caption to post, hashtags + link included — posted verbatim. */
  caption: string;
}

const FB_TOOL: Tool = {
  name: 'emit_facebook_post',
  description: 'Emit a ready-to-post Facebook caption for a completed painting job.',
  input_schema: {
    type: 'object',
    properties: {
      caption: {
        type: 'string',
        description:
          'The complete Facebook caption, ready to post as-is. Structure: 2–4 short, ' +
          'warm sentences about the job (what was done + where), then a light ' +
          'call-to-action, then the project link on its own line IF one is provided, ' +
          'then 3–6 relevant lowercase hashtags on the final line. Plain text only ' +
          '(Facebook has no markdown). A tasteful emoji or two is fine but keep it ' +
          'light. Always include #lakesidepainting and a location hashtag.',
      },
    },
    required: ['caption'],
  },
};

const FB_SYSTEM = [
  'You write Facebook captions for Lakeside Painting / Painters Wanaka, a small',
  'painting business in Wānaka, Central Otago, New Zealand. The audience is local',
  'homeowners and property managers scrolling their feed.',
  'Voice: warm, friendly, first-person plural ("we"), proud of the work but not',
  'salesy. Shorter and a touch more casual than the website — this is social, not',
  'a portfolio page. NZ English.',
  'Keep it tight: roughly 40–80 words before the hashtags. One light call-to-action',
  '(e.g. inviting a free quote). Never invent specifics (colours, brands, m²,',
  'client names) that are not in the inputs. If a detail is unknown, write around it.',
].join('\n');

/**
 * Turn the reviewed website copy + job facts into a Facebook-flavoured caption.
 * Reuses the same facts Brad already approved for the website so the two stay
 * consistent, just reshaped for a feed: shorter, friendlier, hashtags + link.
 */
export async function generateFacebookPost(input: FacebookPostInput): Promise<FacebookPost> {
  const client = getClient();
  const facts = [
    `Job: ${input.jobName}`,
    input.location ? `Location: ${input.location}` : '',
    input.services && input.services.length ? `Services: ${input.services.join(', ')}` : '',
    input.stainProduct ? `Product used: ${input.stainProduct}` : '',
    input.scopeNotes ? `Scope notes: ${input.scopeNotes}` : '',
    input.description ? `Website lead paragraph (the approved facts to draw on): ${input.description}` : '',
    input.overview && input.overview.length ? `Website detail:\n${input.overview.join('\n')}` : '',
    input.projectUrl ? `Project page link to include as the CTA: ${input.projectUrl}` : 'No live project link yet — do NOT invent a URL; end on the call-to-action instead.',
  ].filter(Boolean).join('\n');

  const raw = await callTool(client, {
    system: FB_SYSTEM,
    tool: FB_TOOL,
    maxTokens: 600,
    content:
      'Write ONE Facebook caption for this finished painting job, reshaping the ' +
      'approved website facts below into something friendly and feed-ready. Call ' +
      'emit_facebook_post.\n\n=== THIS JOB ===\n' + facts,
  });

  const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
  if (!caption) throw new Error('AI returned an empty Facebook caption');
  return { caption };
}

// ── Instagram post caption ──────────────────────────────────────────────────

export interface InstagramPost {
  /** The full caption to post, hashtags included — posted verbatim. */
  caption: string;
}

const IG_TOOL: Tool = {
  name: 'emit_instagram_post',
  description: 'Emit a ready-to-post Instagram caption for a completed painting job.',
  input_schema: {
    type: 'object',
    properties: {
      caption: {
        type: 'string',
        description:
          'The complete Instagram caption, ready to post as-is. Structure: 1–3 short, ' +
          'warm sentences about the job (what was done + where), then a light ' +
          'call-to-action ("DM us or get in touch via the link in our bio"), then ' +
          '8–15 relevant lowercase hashtags on the final lines. NEVER include a URL — ' +
          'links are not clickable on Instagram. Plain text, a tasteful emoji or two ' +
          'is fine. Always include #lakesidepainting, #wanaka and a service hashtag.',
      },
    },
    required: ['caption'],
  },
};

const IG_SYSTEM = [
  'You write Instagram captions for Lakeside Painting / Painters Wanaka, a small',
  'painting business in Wānaka, Central Otago, New Zealand. The audience is local',
  'homeowners, builders and property managers scrolling their feed.',
  'Voice: warm, friendly, first-person plural ("we"), proud of the work but not',
  'salesy. Even shorter and more visual-first than Facebook — the photos do the',
  'talking. NZ English.',
  'Keep it tight: roughly 20–50 words before the hashtags. Hashtags carry the',
  'reach on Instagram, so include a solid block of relevant ones (8–15).',
  'NEVER include a URL (not clickable on Instagram) and never invent specifics',
  '(colours, brands, m², client names) that are not in the inputs.',
].join('\n');

/**
 * Instagram twin of generateFacebookPost: same approved facts, reshaped for
 * IG — shorter copy, no link, heavier hashtags.
 */
export async function generateInstagramPost(input: FacebookPostInput): Promise<InstagramPost> {
  const client = getClient();
  const facts = [
    `Job: ${input.jobName}`,
    input.location ? `Location: ${input.location}` : '',
    input.services && input.services.length ? `Services: ${input.services.join(', ')}` : '',
    input.stainProduct ? `Product used: ${input.stainProduct}` : '',
    input.scopeNotes ? `Scope notes: ${input.scopeNotes}` : '',
    input.description ? `Website lead paragraph (the approved facts to draw on): ${input.description}` : '',
    input.overview && input.overview.length ? `Website detail:\n${input.overview.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const raw = await callTool(client, {
    system: IG_SYSTEM,
    tool: IG_TOOL,
    maxTokens: 600,
    content:
      'Write ONE Instagram caption for this finished painting job, reshaping the ' +
      'approved website facts below into something short, warm and feed-ready. ' +
      'Call emit_instagram_post.\n\n=== THIS JOB ===\n' + facts,
  });

  const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
  if (!caption) throw new Error('AI returned an empty Instagram caption');
  return { caption };
}

// ── Image labelling (vision) ────────────────────────────────────────────────

export type VisionImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ImageLabelInput {
  /** Raw image bytes, base64 (no data: prefix). Should be a vision-supported type. */
  dataBase64: string;
  mediaType: VisionImageMediaType;
  /** 'before', 'after', or 'process' (work-in-progress) — steers the description. */
  phase: 'before' | 'after' | 'process';
  location?: string;
  services?: string[];
}

export interface ImageLabel {
  /** kebab-case, lowercase, no extension. Drives both the file name and (on this site) the alt text. */
  seoName: string;
  /** Human-readable alt text describing what's visible. */
  alt: string;
}

const LABEL_TOOL: Tool = {
  name: 'emit_image_label',
  description: 'Emit an SEO filename and alt text for a painting project photo.',
  input_schema: {
    type: 'object',
    properties: {
      seoName: {
        type: 'string',
        description:
          'A descriptive, SEO-friendly file name (NO extension). All lowercase, ' +
          'words separated by hyphens, no spaces or punctuation. Describe what is ' +
          'literally visible and end with the location. ' +
          'E.g. "cedar-cladding-after-staining-front-elevation-wanaka" or ' +
          '"interior-living-room-before-prep-cromwell". 4–9 words.',
      },
      alt: {
        type: 'string',
        description:
          'Natural-language alt text describing what is visible for accessibility ' +
          'and SEO. One sentence, no "image of". E.g. "Freshly stained cedar ' +
          'weatherboard cladding on the front elevation of a Wanaka home."',
      },
    },
    required: ['seoName', 'alt'],
  },
};

const LABEL_SYSTEM = [
  'You label photos for a New Zealand painting company\'s online portfolio.',
  'Look at the photo and describe what is actually visible — surface (cedar,',
  'weatherboard, interior wall, roof, deck), the area, and whether it looks',
  'freshly finished or in its original/prep state. Be specific but truthful;',
  'do not guess colours or materials you cannot see. Output is used as the',
  'image file name and alt text, which drive image SEO.',
].join('\n');

/** Sanitise whatever the model returns into a safe kebab-case basename. */
export function sanitizeSeoName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')        // strip any extension the model added
    .replace(/[^a-z0-9]+/g, '-')          // non-alphanumerics → hyphen
    .replace(/-+/g, '-')                  // collapse repeats
    .replace(/^-|-$/g, '');               // trim edges
  return clean || 'project-photo';
}

export async function labelProjectImage(input: ImageLabelInput): Promise<ImageLabel> {
  const client = getClient();
  const context = [
    `This is a "${input.phase}" photo of a painting job.`,
    input.location ? `Location: ${input.location}.` : '',
    input.services && input.services.length ? `Work: ${input.services.join(', ')}.` : '',
    'Call emit_image_label with an SEO file name and alt text for it.',
  ].filter(Boolean).join(' ');

  const raw = await callTool(client, {
    system: LABEL_SYSTEM,
    tool: LABEL_TOOL,
    maxTokens: 300,
    content: [
      { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.dataBase64 } },
      { type: 'text', text: context },
    ],
  });

  const seoName = sanitizeSeoName(typeof raw.seoName === 'string' ? raw.seoName : '');
  const alt = typeof raw.alt === 'string' && raw.alt.trim() ? raw.alt.trim() : seoName.replace(/-/g, ' ');
  return { seoName, alt };
}
