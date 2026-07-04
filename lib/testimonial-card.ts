// Testimonial card renderer — CLIENT-ONLY (uses <canvas>).
//
// Draws the client's review as a branded 1080×1080 card, matching the design
// Brad previously built by hand in Figma for Facebook posts:
//
//   ┌────────────────────────────┐
//   │  “  (big light-blue mark)  │
//   │  The review text, wrapped  │
//   │  over a few lines in a     │
//   │  friendly geometric font.  │
//   │                            │
//   │  ★★★★★  (amber)            │
//   │  Client Name  (bold)       │
//   │  Home Owner   (grey)       │
//   └────────────────────────────┘
//
// Composition rules (the part that makes it look designed, not generated):
//   - The quote mark and the review move as ONE GROUP, optically centred in
//     the space above the stars (slightly high of true centre — pure centring
//     reads bottom-heavy to the eye). Short and long reviews both balance.
//   - The mark's position is computed from its MEASURED ink box, so the gap
//     between mark and text is a real visual gap, not a guess that drifts
//     with the font's side bearings.
//   - Paragraph breaks in the review are preserved with a partial-line gap —
//     long reviews read as prose, not a wall of text.
//   - The star row + name + role are pinned to the bottom on a fixed grid,
//     giving every card the same anchored, confident footer.
//
// Pure function of its inputs → a PNG Blob. No React, no network, no server.
// PNG on purpose: flat colours + text compress tiny and stay razor-sharp;
// callers should upload with skipCompression so the JPEG re-encoder doesn't
// smear the text (Facebook's own pipeline converts it once at post time).
//
// The caller passes the CSS font-family string (from next/font's Poppins) and
// should have awaited document.fonts.load() for the weights used — see
// ensureCardFonts() below, which does exactly that.

export const CARD_SIZE = 1080;

// Palette lifted from the Figma design.
const COLOR_BG = '#ffffff';
const COLOR_QUOTE_MARK = '#c9d3df'; // light blue-grey
const COLOR_BODY = '#3f444b';       // near-black grey
const COLOR_STARS = '#e9a63c';      // amber
const COLOR_NAME = '#22262b';
const COLOR_ROLE = '#4b535b';

// Layout constants (all in card px).
const MARGIN_X = 84;
const BODY_MAX_WIDTH = CARD_SIZE - MARGIN_X * 2;

// The mark + review group is centred inside this vertical band.
const AREA_TOP = 72;
const AREA_BOTTOM = 748;
// Optical centring: give the top slightly LESS of the leftover space than
// the bottom (42/58). Equal padding looks bottom-heavy to the human eye.
const TOP_SHARE = 0.42;

// The quote mark is DRAWN, not a font glyph — two slab commas matching the
// mark in Brad's original Figma design: a big rounded top-left sweep, flat
// top, a concave notch bitten out of the right side, and a solid square
// block at the bottom. Design box per comma is 100×200; scaled at render.
const MARK_HEIGHT = 118;
const MARK_SCALE = MARK_HEIGHT / 200;
const MARK_STEP = 122;    // second comma's x-offset in design units
const MARK_TEXT_GAP = 44; // gap between mark ink and first cap line

// Fixed footer grid.
const STARS_Y = 838;        // vertical centre of the star row
const STAR_R = 21;
const STAR_STEP = 56;       // centre-to-centre
const NAME_BASELINE = 934;
const ROLE_BASELINE = 990;

// Type scale for the review. CAP_RATIO approximates Poppins' cap height.
const REVIEW_SIZES = [54, 50, 46, 42, 38, 34, 31] as const;
const LINE_HEIGHT_RATIO = 1.52;
const PARAGRAPH_GAP_RATIO = 0.55; // extra gap between paragraphs, in lines
const CAP_RATIO = 0.7;

export interface TestimonialCardInput {
  /** The client's words, verbatim. Blank lines become paragraph breaks. */
  quote: string;
  /** Who said it — rendered bold under the stars. */
  author: string;
  /** Role line under the name. Empty string hides the line. */
  role?: string;
  /**
   * CSS font-family list to draw with (e.g. next/font Poppins's
   * `style.fontFamily`). Falls back to system sans if the fonts aren't
   * loaded — the card still renders, just less on-brand.
   */
  fontFamily: string;
}

/**
 * Await the font weights the card uses so canvas text doesn't fall back to
 * the system font on first render. Safe to call repeatedly (the browser
 * caches). Never throws — a font miss degrades, it doesn't break.
 */
export async function ensureCardFonts(fontFamily: string): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const specs = [
    `500 54px ${fontFamily}`,
    `600 46px ${fontFamily}`,
    `400 30px ${fontFamily}`,
  ];
  try {
    await Promise.all(specs.map((s) => document.fonts.load(s)));
  } catch {
    /* degrade silently */
  }
}

/** Greedy word-wrap using real text metrics. */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A wrapped line plus its y-offset from the first baseline. */
interface PlacedLine {
  text: string;
  offset: number;
}

/**
 * Wrap all paragraphs at a given font size and lay them out relative to the
 * first baseline (offset 0), inserting the paragraph gap between paragraphs.
 * Returns the placed lines and the total visual block height (cap of first
 * line → baseline of last line).
 */
function layoutReview(
  ctx: CanvasRenderingContext2D,
  paragraphs: string[],
  fontSize: number,
  fontFamily: string,
): { lines: PlacedLine[]; blockHeight: number } {
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
  const paragraphGap = Math.round(lineHeight * PARAGRAPH_GAP_RATIO);
  ctx.font = `500 ${fontSize}px ${fontFamily}`;

  const lines: PlacedLine[] = [];
  let offset = 0;
  paragraphs.forEach((para, pIdx) => {
    if (pIdx > 0) offset += paragraphGap;
    for (const text of wrapLines(ctx, para, BODY_MAX_WIDTH)) {
      lines.push({ text, offset });
      offset += lineHeight;
    }
  });
  // `offset` now sits one lineHeight past the last baseline; walk it back.
  const lastBaseline = lines.length > 0 ? lines[lines.length - 1].offset : 0;
  return { lines, blockHeight: fontSize * CAP_RATIO + lastBaseline };
}

/**
 * One slab comma from the Figma mark, in a 100×200 design box scaled by s.
 * (x, y) is the box's top-left. Outline: rounded top-left sweep → flat top →
 * down the right edge → concave notch curling left (open to the right) →
 * flat notch underside → solid block to a square bottom.
 */
function slabCommaPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
): void {
  ctx.moveTo(x, y + 58 * s);
  ctx.quadraticCurveTo(x, y, x + 58 * s, y);
  ctx.lineTo(x + 100 * s, y);
  ctx.lineTo(x + 100 * s, y + 62 * s);
  ctx.quadraticCurveTo(x + 46 * s, y + 62 * s, x + 46 * s, y + 112 * s);
  ctx.lineTo(x + 100 * s, y + 112 * s);
  ctx.lineTo(x + 100 * s, y + 200 * s);
  ctx.lineTo(x, y + 200 * s);
  ctx.closePath();
}

/** Classic five-pointed star path centred on (cx, cy). */
function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
): void {
  const innerR = outerR * 0.44;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Render the card and return it as a PNG Blob.
 *
 * The review font auto-shrinks (54 → 31px) until the mark + text group fits
 * the band above the stars, so a long-winded review still produces a clean,
 * balanced card instead of overflowing.
 */
export async function renderTestimonialCard(input: TestimonialCardInput): Promise<Blob> {
  const author = input.author.trim();
  const role = (input.role ?? '').trim();
  // Blank-line separated chunks become paragraphs; single newlines too —
  // people paste reviews with all sorts of line-break habits.
  const paragraphs = input.quote
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) throw new Error('Testimonial text is empty.');

  const canvas = document.createElement('canvas');
  canvas.width = CARD_SIZE;
  canvas.height = CARD_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');

  // Background.
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  ctx.textBaseline = 'alphabetic';

  // Fit the review: walk the type scale down until mark + gap + text fits.
  let fontSize: number = REVIEW_SIZES[0];
  let layout = layoutReview(ctx, paragraphs, fontSize, input.fontFamily);
  const areaHeight = AREA_BOTTOM - AREA_TOP;
  for (const size of REVIEW_SIZES) {
    fontSize = size;
    layout = layoutReview(ctx, paragraphs, size, input.fontFamily);
    const groupHeight = MARK_HEIGHT + MARK_TEXT_GAP + layout.blockHeight;
    if (groupHeight <= areaHeight) break;
  }

  // Optically centre the whole group in the band.
  const groupHeight = MARK_HEIGHT + MARK_TEXT_GAP + layout.blockHeight;
  const leftover = Math.max(0, areaHeight - groupHeight);
  const groupTop = AREA_TOP + leftover * TOP_SHARE;

  // Quote mark — two slab commas, ink top landing exactly on groupTop.
  ctx.fillStyle = COLOR_QUOTE_MARK;
  ctx.beginPath();
  slabCommaPath(ctx, MARGIN_X, groupTop, MARK_SCALE);
  slabCommaPath(ctx, MARGIN_X + MARK_STEP * MARK_SCALE, groupTop, MARK_SCALE);
  ctx.fill();

  // Review text.
  ctx.fillStyle = COLOR_BODY;
  ctx.font = `500 ${fontSize}px ${input.fontFamily}`;
  const firstBaseline =
    groupTop + MARK_HEIGHT + MARK_TEXT_GAP + fontSize * CAP_RATIO;
  for (const line of layout.lines) {
    ctx.fillText(line.text, MARGIN_X, firstBaseline + line.offset);
  }

  // Five amber stars on the fixed footer grid.
  ctx.fillStyle = COLOR_STARS;
  for (let i = 0; i < 5; i++) {
    starPath(ctx, MARGIN_X + STAR_R + i * STAR_STEP, STARS_Y, STAR_R);
    ctx.fill();
  }

  // Name + role.
  if (author) {
    ctx.fillStyle = COLOR_NAME;
    ctx.font = `600 44px ${input.fontFamily}`;
    ctx.fillText(author, MARGIN_X, NAME_BASELINE);
  }
  if (role) {
    ctx.fillStyle = COLOR_ROLE;
    ctx.font = `400 29px ${input.fontFamily}`;
    ctx.fillText(role, MARGIN_X, ROLE_BASELINE);
  }

  const blob: Blob | null = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
  if (!blob) throw new Error("Couldn't encode the testimonial image.");
  return blob;
}
