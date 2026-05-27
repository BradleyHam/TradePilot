'use client';

// =============================================================
// QuotePdfDocument — branded quote PDF (Lakeside template)
// =============================================================
//
// Mirrors the Python `quote_generator.py` layout that Brad already
// uses for his manually-prepared quotes. Same palette, same blocks,
// same hierarchy — the customer should not be able to tell which
// quotes came from the app vs. the previous flow.
//
// Layout, top to bottom:
//
//   1. Top accent bar (dark slate + tan strip)
//   2. Header: logo top-left, QUOTE + number/date top-right
//   3. Three-column info strip: FROM / PREPARED FOR / DETAILS
//   4. Scope paragraph
//   5. Line items table (alternating row backgrounds, total block)
//   6. Side-by-side WHAT'S INCLUDED + NOT INCLUDED boxes
//   7. Estimated timeline box
//   8. Numbered T&Cs
//   9. "Ready to go ahead?" call-to-action
//   10. Footer accent bar with thank-you note
//
// React-PDF doesn't support Tailwind so styles are hand-rolled.
// All sizing uses pts (72/inch). A4 portrait = 595×842 pt.

import {
  Document, Page, Text, View, Image, StyleSheet, Font,
} from '@react-pdf/renderer';
import type { DraftedQuote } from '@/lib/quote-drafter';
import type { Job, QuoteTemplate } from '@/lib/types';

// React-PDF's default hyphenation likes to split words mid-line in
// awkward places. Disabling it gives slightly looser ragged-right
// edges but reads like a real document instead of a textbook.
Font.registerHyphenationCallback((word: string) => [word]);

// ── Lakeside brand palette ────────────────────────────────────────────
// Ported verbatim from quote_generator.py so the AI-generated PDFs
// look identical to Brad's hand-prepared ones.
const COLORS = {
  darkSlate:   '#3B4D5C',
  midGrey:     '#6B7B8D',
  lightGrey:   '#F4F5F6',
  accentGreen: '#5C6B56',
  accentTan:   '#C4B48A',
  textBlack:   '#2D2D2D',
  rule:        '#D9DDE1',
  white:       '#FFFFFF',
  incBg:       '#EFF3ED',  // light green-grey tint for inclusions
  excBg:       '#F5F0EA',  // light warm grey for exclusions
};

// ── Stylesheet ────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // Page itself — give plenty of bottom padding so the footer accent
  // bar (positioned absolutely) doesn't crowd the last content row.
  page: {
    paddingTop: 36,
    paddingBottom: 60,
    paddingHorizontal: 36,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: COLORS.textBlack,
    lineHeight: 1.5,
  },
  // ── Accent bars ──
  topAccentDark: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 17,
    backgroundColor: COLORS.darkSlate,
  },
  topAccentTan: {
    position: 'absolute',
    top: 17, left: 0, right: 0,
    height: 4,
    backgroundColor: COLORS.accentTan,
  },
  bottomAccentTan: {
    position: 'absolute',
    bottom: 22, left: 0, right: 0,
    height: 4,
    backgroundColor: COLORS.accentTan,
  },
  bottomAccentDark: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    height: 22,
    backgroundColor: COLORS.darkSlate,
  },
  footerThanks: {
    position: 'absolute',
    bottom: 38,
    left: 0, right: 0,
    fontSize: 9,
    color: COLORS.midGrey,
    textAlign: 'center',
  },

  // ── Header row ──
  // marginTop is high enough that the QUOTE word + ref number sit
  // BELOW the accent bars (which take the top 21pt). Without enough
  // top margin, the right-aligned QUOTE block crashed into the bars
  // and the ref number ended up underlapping. 32pt gives clean air.
  header: {
    marginTop: 32,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  // Headers's right side wraps QUOTE + ref in its own flex column so
  // the ref renders on a new line, not on top of the word.
  headerRight: {
    alignItems: 'flex-end',
  },
  logo: {
    width: 110,
    height: 50,
    objectFit: 'contain',
  },
  quoteWord: {
    fontSize: 26,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkSlate,
    letterSpacing: 1,
    textAlign: 'right',
  },
  quoteRef: {
    fontSize: 10,
    color: COLORS.midGrey,
    textAlign: 'right',
    marginTop: 2,
  },
  divider: {
    marginTop: 18,
    height: 0.5,
    backgroundColor: COLORS.rule,
  },

  // ── Three-column info strip ──
  infoRow: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 16,
  },
  infoCol: {
    flex: 1,
  },
  colLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accentGreen,
    letterSpacing: 0.8,
    marginBottom: 5,
  },
  colHeading: {
    fontSize: 10,
    color: COLORS.textBlack,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  colMeta: {
    fontSize: 8.5,
    color: COLORS.midGrey,
    marginBottom: 2,
    lineHeight: 1.45,
  },
  detailRow: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  detailLabel: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.textBlack,
    width: 50,
  },
  detailValue: {
    fontSize: 8.5,
    color: COLORS.midGrey,
    flex: 1,
  },

  // ── Section headings (small olive labels) ──
  sectionLabel: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accentGreen,
    letterSpacing: 0.8,
    marginTop: 18,
    marginBottom: 6,
  },

  // ── Scope paragraph ──
  scopeText: {
    fontSize: 10,
    color: COLORS.textBlack,
    lineHeight: 1.55,
  },

  // ── Line items table ──
  table: {
    marginTop: 2,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.rule,
  },
  tableHeaderText: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accentGreen,
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    paddingHorizontal: 8,
  },
  tableRowAlt: {
    backgroundColor: COLORS.lightGrey,
  },
  cellDesc: { flex: 4, paddingRight: 8 },
  cellAmount: { flex: 1.4, textAlign: 'right' },
  itemText: {
    fontSize: 9.5,
    color: COLORS.textBlack,
    lineHeight: 1.4,
  },

  // Totals (below the table)
  totalsRow: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 3,
    justifyContent: 'flex-end',
  },
  totalsLabel: {
    fontSize: 9,
    color: COLORS.midGrey,
    textAlign: 'right',
    paddingRight: 14,
  },
  totalsValue: {
    fontSize: 9,
    color: COLORS.midGrey,
    width: 90,
    textAlign: 'right',
  },
  totalsLine: {
    height: 0.5,
    backgroundColor: COLORS.rule,
    marginVertical: 4,
    marginHorizontal: 8,
  },
  totalsRowFinal: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 8,
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: COLORS.darkSlate,
    marginHorizontal: 8,
    marginTop: 6,
  },
  totalsLabelFinal: {
    fontSize: 11.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkSlate,
    textAlign: 'right',
    paddingRight: 14,
  },
  totalsValueFinal: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkSlate,
    width: 100,
    textAlign: 'right',
  },

  // ── Included / Excluded boxes ──
  incExcRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  incBox: {
    flex: 1,
    backgroundColor: COLORS.incBg,
    borderRadius: 6,
    padding: 12,
  },
  excBox: {
    flex: 1,
    backgroundColor: COLORS.excBg,
    borderRadius: 6,
    padding: 12,
  },
  incExcLabel: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accentGreen,
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  excLabel: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.midGrey,
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  bulletRow: {
    flexDirection: 'row',
    marginBottom: 5,
  },
  bulletMark: {
    width: 14,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accentGreen,
  },
  bulletMarkExc: {
    width: 14,
    fontSize: 9,
    color: COLORS.midGrey,
  },
  bulletText: {
    flex: 1,
    fontSize: 8.5,
    color: COLORS.textBlack,
    lineHeight: 1.45,
  },
  bulletTextExc: {
    flex: 1,
    fontSize: 8.5,
    color: COLORS.midGrey,
    lineHeight: 1.45,
  },

  // ── Timeline box ──
  timelineBox: {
    backgroundColor: COLORS.lightGrey,
    borderRadius: 6,
    padding: 12,
    marginTop: 4,
  },
  timelineGrid: {
    flexDirection: 'row',
    gap: 24,
    marginBottom: 4,
  },
  timelineItem: {
    flexDirection: 'row',
    gap: 4,
  },
  timelineLabel: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.textBlack,
  },
  timelineValue: {
    fontSize: 8.5,
    color: COLORS.midGrey,
  },
  timelineNote: {
    fontSize: 8.5,
    color: COLORS.midGrey,
    marginTop: 4,
    lineHeight: 1.45,
  },

  // ── Terms ──
  termRow: {
    flexDirection: 'row',
    marginBottom: 3,
  },
  termNumber: {
    width: 16,
    fontSize: 8.5,
    color: COLORS.midGrey,
  },
  termText: {
    flex: 1,
    fontSize: 8.5,
    color: COLORS.midGrey,
    lineHeight: 1.5,
  },

  // ── CTA ──
  ctaDivider: {
    marginTop: 14,
    height: 1,
    backgroundColor: COLORS.accentTan,
  },
  ctaHeading: {
    marginTop: 10,
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkSlate,
  },
  ctaText: {
    marginTop: 4,
    fontSize: 9.5,
    color: COLORS.midGrey,
    lineHeight: 1.55,
  },

  // Pay block (above CTA)
  payText: {
    fontSize: 9.5,
    color: COLORS.textBlack,
    marginBottom: 4,
  },
});

// ── Props ─────────────────────────────────────────────────────────────

export interface QuotePdfProps {
  draft: DraftedQuote;
  template: QuoteTemplate;
  job: Job;
  /** Public URL for the business logo, if uploaded. Already resolved
   *  by the caller via store.resolveLogoUrl(). null = render without. */
  logoUrl: string | null;
  /** Quote number for the header, e.g. Q-2026-0524-1830. */
  quoteNumber?: string;
}

// ── Main component ────────────────────────────────────────────────────

export function QuotePdfDocument({
  draft, template, job, logoUrl, quoteNumber,
}: QuotePdfProps) {
  const businessName = template.header.businessName || 'Lakeside Painting';
  const dateStr = new Date().toLocaleDateString('en-NZ', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const validForStr = `${template.validityDays ?? 30} days`;

  // Customer-facing line summarising payment terms. Drawn above the
  // CTA so the headline expectation can't be missed.
  const payLine = (() => {
    const dep = template.paymentTerms.depositPercent;
    const due = template.paymentTerms.balanceDue === 'on_completion'
      ? 'balance payable on completion'
      : 'balance progress-billed';
    return `${dep}% deposit to confirm booking; ${due}.`;
  })();

  // T&Cs — the template stores them as a single text blob with each
  // line a separate "rule". We split on newlines and drop empties to
  // produce a clean numbered list.
  const terms = (template.defaultTerms ?? '')
    .split('\n')
    .map((s) => s.trim().replace(/^[•\-*]\s*/, '')) // strip leading bullet chars
    .filter(Boolean);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Top accent bars */}
        <View style={styles.topAccentDark} fixed />
        <View style={styles.topAccentTan} fixed />

        {/* Header */}
        <View style={styles.header}>
          {logoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={logoUrl} style={styles.logo} />
          ) : (
            <Text style={[styles.quoteWord, { textAlign: 'left', color: COLORS.darkSlate }]}>
              {businessName}
            </Text>
          )}
          <View style={styles.headerRight}>
            <Text style={styles.quoteWord}>QUOTE</Text>
            {quoteNumber && <Text style={styles.quoteRef}>{quoteNumber}</Text>}
          </View>
        </View>

        <View style={styles.divider} />

        {/* Three-column info strip */}
        <View style={styles.infoRow}>
          {/* FROM */}
          <View style={styles.infoCol}>
            <Text style={styles.colLabel}>FROM</Text>
            <Text style={styles.colHeading}>{businessName}</Text>
            {template.header.address && <Text style={styles.colMeta}>{template.header.address}</Text>}
            {template.header.phone && <Text style={styles.colMeta}>{template.header.phone}</Text>}
            {template.header.email && <Text style={styles.colMeta}>{template.header.email}</Text>}
            {template.header.gstNumber && (
              <Text style={styles.colMeta}>GST: {template.header.gstNumber}</Text>
            )}
          </View>

          {/* PREPARED FOR */}
          <View style={styles.infoCol}>
            <Text style={styles.colLabel}>PREPARED FOR</Text>
            <Text style={styles.colHeading}>{job.clientName}</Text>
            {job.location && <Text style={styles.colMeta}>{job.location}</Text>}
            {job.clientPhone && <Text style={styles.colMeta}>{job.clientPhone}</Text>}
            {job.clientEmail && <Text style={styles.colMeta}>{job.clientEmail}</Text>}
          </View>

          {/* DETAILS */}
          <View style={styles.infoCol}>
            <Text style={styles.colLabel}>DETAILS</Text>
            <Detail label="Date" value={dateStr} />
            {quoteNumber && <Detail label="Ref" value={quoteNumber} />}
            <Detail label="Project" value={truncate(job.name, 30)} />
            <Detail label="Valid" value={validForStr} />
          </View>
        </View>

        {/* Scope */}
        <Text style={styles.sectionLabel}>SCOPE OF WORK</Text>
        <Text style={styles.scopeText}>{draft.scopeParagraph}</Text>

        {/* Line items + totals */}
        <Text style={styles.sectionLabel}>PRICING</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.cellDesc, styles.tableHeaderText]}>Description</Text>
            <Text style={[styles.cellAmount, styles.tableHeaderText]}>Amount</Text>
          </View>
          {draft.lineItems.map((item, i) => (
            <View
              key={i}
              // React-PDF's Style typing doesn't accept null inside style
              // arrays (unlike React Native). Spread only the alt style
              // when we're on an odd-index row; otherwise just the base.
              style={i % 2 === 1 ? [styles.tableRow, styles.tableRowAlt] : styles.tableRow}
              wrap={false}
            >
              <View style={styles.cellDesc}>
                <Text style={styles.itemText}>{item.description}</Text>
              </View>
              <Text style={[styles.cellAmount, styles.itemText]}>
                {formatMoney(item.totalExGst)}
              </Text>
            </View>
          ))}

          {/* Totals — subtotal / GST / TOTAL */}
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Subtotal (excl. GST)</Text>
            <Text style={styles.totalsValue}>{formatMoney(draft.subtotalExGst)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>GST (15%)</Text>
            <Text style={styles.totalsValue}>{formatMoney(draft.gstAmount)}</Text>
          </View>
          <View style={styles.totalsRowFinal}>
            <Text style={styles.totalsLabelFinal}>Total (incl. GST)</Text>
            <Text style={styles.totalsValueFinal}>{formatMoney(draft.totalInclGst)}</Text>
          </View>
        </View>

        {/* Inclusions / Exclusions — side by side */}
        {(draft.inclusions.length > 0 || draft.exclusions.length > 0) && (
          <View style={styles.incExcRow}>
            {draft.inclusions.length > 0 && (
              <View style={styles.incBox}>
                <Text style={styles.incExcLabel}>WHAT&apos;S INCLUDED</Text>
                {draft.inclusions.map((line, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <Text style={styles.bulletMark}>{'✓'}</Text>
                    <Text style={styles.bulletText}>{line}</Text>
                  </View>
                ))}
              </View>
            )}
            {draft.exclusions.length > 0 && (
              <View style={styles.excBox}>
                <Text style={styles.excLabel}>NOT INCLUDED</Text>
                {draft.exclusions.map((line, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <Text style={styles.bulletMarkExc}>{'–'}</Text>
                    <Text style={styles.bulletTextExc}>{line}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Timeline */}
        {(draft.timeline.estimatedStart || draft.timeline.duration || draft.timeline.notes) && (
          <>
            <Text style={styles.sectionLabel}>ESTIMATED TIMELINE</Text>
            <View style={styles.timelineBox}>
              <View style={styles.timelineGrid}>
                {draft.timeline.estimatedStart && (
                  <View style={styles.timelineItem}>
                    <Text style={styles.timelineLabel}>Start:</Text>
                    <Text style={styles.timelineValue}>{draft.timeline.estimatedStart}</Text>
                  </View>
                )}
                {draft.timeline.duration && (
                  <View style={styles.timelineItem}>
                    <Text style={styles.timelineLabel}>Duration:</Text>
                    <Text style={styles.timelineValue}>{draft.timeline.duration}</Text>
                  </View>
                )}
              </View>
              {draft.timeline.notes && (
                <Text style={styles.timelineNote}>
                  <Text style={styles.timelineLabel}>Note: </Text>
                  {draft.timeline.notes}
                </Text>
              )}
            </View>
          </>
        )}

        {/* Payment */}
        <Text style={styles.sectionLabel}>PAYMENT</Text>
        <Text style={styles.payText}>{payLine}</Text>

        {/* Terms */}
        {terms.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>TERMS &amp; CONDITIONS</Text>
            {terms.map((term, i) => (
              <View key={i} style={styles.termRow}>
                <Text style={styles.termNumber}>{i + 1}.</Text>
                <Text style={styles.termText}>{term}</Text>
              </View>
            ))}
          </>
        )}

        {/* Call to action */}
        <View style={styles.ctaDivider} />
        <Text style={styles.ctaHeading}>Ready to go ahead?</Text>
        <Text style={styles.ctaText}>
          Simply reply to this quote
          {template.header.phone ? ` or give us a call on ${template.header.phone}` : ''}
          {' '}to confirm. We&apos;ll get your project booked in.
        </Text>

        {/* Bottom accent bars + thank-you */}
        <Text style={styles.footerThanks} fixed>
          Thank you for considering {businessName}
        </Text>
        <View style={styles.bottomAccentTan} fixed />
        <View style={styles.bottomAccentDark} fixed />
      </Page>
    </Document>
  );
}

// ── Small components / helpers ────────────────────────────────────────

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}:</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function formatMoney(n: number): string {
  return `$${n.toLocaleString('en-NZ', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
