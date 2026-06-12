'use client';

// =============================================================
// InvoicePdfDocument — branded invoice PDF (Lakeside template)
// =============================================================
//
// Mirrors the deposit-invoice layout Brad already uses (reference:
// INV-034-DEP). Same navy + tan branding as the quote PDF
// (`components/quotes/quote-pdf.tsx`) so a customer can't tell which
// document came from the app vs. the old flow.
//
// Layout, top to bottom:
//   1. Top accent bars (dark slate + tan strip)
//   2. Header: logo top-left, INVOICE + number top-right
//   3. Three-column strip: FROM / BILLED TO / DETAILS
//   4. Line item (description + amount, GST-inclusive)
//   5. Totals block: subtotal ex-GST / GST / Total Due incl-GST
//   6. Side-by-side PAYMENT DETAILS + NOTES boxes
//   7. Footer accent bar with thank-you note
//
// React-PDF doesn't support Tailwind, so styles are hand-rolled in pts.
// A4 portrait = 595×842 pt.

import {
  Document, Page, Text, View, Image, StyleSheet, Font,
} from '@react-pdf/renderer';
import type { Job, QuoteTemplate } from '@/lib/types';
import type { InvoicePdfData } from '@/lib/invoice-pdf-data';

// React-PDF's default hyphenation splits words mid-line awkwardly.
// Disabling it reads like a real document.
Font.registerHyphenationCallback((word: string) => [word]);

// ── Lakeside brand palette (ported from quote-pdf.tsx) ────────────────
const COLORS = {
  darkSlate:  '#3B4D5C',
  midGrey:    '#6B7B8D',
  lightGrey:  '#F4F5F6',
  accentGreen:'#5C6B56',
  accentTan:  '#C4B48A',
  textBlack:  '#2D2D2D',
  rule:       '#D9DDE1',
  white:      '#FFFFFF',
  payBg:      '#F4F5F6', // payment box — light grey
  notesBg:    '#F5F0EA', // notes box — warm grey
};

const styles = StyleSheet.create({
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
    position: 'absolute', top: 0, left: 0, right: 0,
    height: 17, backgroundColor: COLORS.darkSlate,
  },
  topAccentTan: {
    position: 'absolute', top: 17, left: 0, right: 0,
    height: 4, backgroundColor: COLORS.accentTan,
  },
  bottomAccentTan: {
    position: 'absolute', bottom: 22, left: 0, right: 0,
    height: 4, backgroundColor: COLORS.accentTan,
  },
  bottomAccentDark: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 22, backgroundColor: COLORS.darkSlate,
  },
  footerThanks: {
    position: 'absolute', bottom: 38, left: 0, right: 0,
    fontSize: 9, color: COLORS.midGrey, textAlign: 'center',
  },

  // ── Header ──
  header: {
    marginTop: 32,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerRight: { alignItems: 'flex-end' },
  logo: { width: 150, height: 64, objectFit: 'contain' },
  // lineHeight:1 keeps the 26pt word in a tight box so the ref number
  // below it (marginTop) can't overlap it — the global page lineHeight of
  // 1.5 was inflating the box and crashing the two together.
  titleWord: {
    fontSize: 26,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.darkSlate,
    letterSpacing: 1,
    textAlign: 'right',
    lineHeight: 1,
  },
  titleRef: {
    fontSize: 10,
    color: COLORS.midGrey,
    textAlign: 'right',
    marginTop: 5,
  },
  divider: { marginTop: 18, height: 0.5, backgroundColor: COLORS.rule },

  // ── Three-column info strip ──
  infoRow: { marginTop: 14, flexDirection: 'row', gap: 16 },
  infoCol: { flex: 1 },
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
  detailRow: { flexDirection: 'row', marginBottom: 2 },
  detailLabel: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.textBlack,
    width: 64,
  },
  detailValue: { fontSize: 8.5, color: COLORS.midGrey, flex: 1 },

  // ── Line items table ──
  table: { marginTop: 22 },
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
  tableRow: { flexDirection: 'row', paddingVertical: 9, paddingHorizontal: 8 },
  cellDesc: { flex: 4, paddingRight: 8 },
  cellAmount: { flex: 1.4, textAlign: 'right' },
  itemTitle: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: COLORS.textBlack },
  itemDesc: { fontSize: 9, color: COLORS.midGrey, lineHeight: 1.5, marginTop: 3 },

  // ── Totals ──
  totalsWrap: { marginTop: 4 },
  totalsRow: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 3,
    justifyContent: 'flex-end',
  },
  totalsLabel: {
    fontSize: 9, color: COLORS.midGrey, textAlign: 'right', paddingRight: 14,
  },
  totalsValue: { fontSize: 9, color: COLORS.midGrey, width: 100, textAlign: 'right' },
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
    width: 110,
    textAlign: 'right',
  },

  // ── Payment + Notes boxes ──
  boxRow: { flexDirection: 'row', gap: 12, marginTop: 24 },
  payBox: { flex: 1, backgroundColor: COLORS.payBg, borderRadius: 6, padding: 12 },
  notesBox: { flex: 1, backgroundColor: COLORS.notesBg, borderRadius: 6, padding: 12 },
  boxLabel: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accentGreen,
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  boxLine: { fontSize: 8.5, color: COLORS.midGrey, marginBottom: 3, lineHeight: 1.45 },
  boxLineLabel: { fontFamily: 'Helvetica-Bold', color: COLORS.textBlack },
  boxPlaceholder: { fontSize: 8.5, color: COLORS.midGrey, lineHeight: 1.45 },
  notesText: { fontSize: 8.5, color: COLORS.textBlack, lineHeight: 1.5 },
});

// ── Props ─────────────────────────────────────────────────────────────

// InvoicePdfData now lives in lib/invoice-pdf-data.ts (imported above) so
// plain server/lib code can build it without importing this 'use client'
// module.

export interface InvoicePdfProps {
  data: InvoicePdfData;
  template: QuoteTemplate;
  job: Job;
  /** Public URL for the business logo, resolved by the caller. null = no logo. */
  logoUrl: string | null;
}

// ── Main component ────────────────────────────────────────────────────

export function InvoicePdfDocument({ data, template, job, logoUrl }: InvoicePdfProps) {
  const h = template.header;
  const businessName = h.businessName || 'Lakeside Painting';
  // FROM block lines — prefer the saved template, fall back to Lakeside's
  // known contact details so a blank template still produces a usable doc.
  const fromLines = [
    h.address || 'Wanaka, New Zealand',
    h.phone || '022 106 0336',
    h.email || 'info@lakesidepainting.co.nz',
    h.website || 'lakesidepainting.co.nz',
  ];
  const bank = template.bankDetails;
  const hasBank = Boolean(bank?.accountName || bank?.bankName || bank?.accountNumber);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.topAccentDark} fixed />
        <View style={styles.topAccentTan} fixed />

        {/* Header */}
        <View style={styles.header}>
          {logoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={logoUrl} style={styles.logo} />
          ) : (
            <Text style={[styles.titleWord, { textAlign: 'left' }]}>{businessName}</Text>
          )}
          <View style={styles.headerRight}>
            <Text style={styles.titleWord}>INVOICE</Text>
            <Text style={styles.titleRef}>{data.invoiceNumber}</Text>
          </View>
        </View>

        <View style={styles.divider} />

        {/* Three-column info strip */}
        <View style={styles.infoRow}>
          {/* FROM */}
          <View style={styles.infoCol}>
            <Text style={styles.colLabel}>FROM</Text>
            <Text style={styles.colHeading}>{businessName}</Text>
            {fromLines.map((line, i) => (
              <Text key={i} style={styles.colMeta}>{line}</Text>
            ))}
            {h.gstNumber ? <Text style={styles.colMeta}>GST: {h.gstNumber}</Text> : null}
          </View>

          {/* BILLED TO */}
          <View style={styles.infoCol}>
            <Text style={styles.colLabel}>BILLED TO</Text>
            <Text style={styles.colHeading}>{job.clientName}</Text>
            {job.clientEmail ? <Text style={styles.colMeta}>{job.clientEmail}</Text> : null}
            {job.location ? <Text style={styles.colMeta}>{job.location}</Text> : null}
            {job.clientPhone ? <Text style={styles.colMeta}>{job.clientPhone}</Text> : null}
          </View>

          {/* DETAILS */}
          <View style={styles.infoCol}>
            <Text style={styles.colLabel}>DETAILS</Text>
            <Detail label="Invoice Date" value={data.invoiceDateDisplay} />
            {data.quoteRef ? <Detail label="Quote Ref" value={data.quoteRef} /> : null}
            {data.projectName ? <Detail label="Project" value={data.projectName} /> : null}
            <Detail label="Due" value={data.dueText} />
          </View>
        </View>

        {/* Line item */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.cellDesc, styles.tableHeaderText]}>Description</Text>
            <Text style={[styles.cellAmount, styles.tableHeaderText]}>Amount</Text>
          </View>
          <View style={styles.tableRow} wrap={false}>
            <View style={styles.cellDesc}>
              <Text style={styles.itemTitle}>{data.lineTitle}</Text>
              <Text style={styles.itemDesc}>{data.description}</Text>
            </View>
            <Text style={[styles.cellAmount, styles.itemTitle]}>
              {money(data.lineAmountInclGst)}
            </Text>
          </View>
        </View>

        {/* Totals */}
        <View style={styles.totalsWrap}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Subtotal (excl. GST)</Text>
            <Text style={styles.totalsValue}>{money(data.subtotalExGst)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>GST (15%)</Text>
            <Text style={styles.totalsValue}>{money(data.gstAmount)}</Text>
          </View>
          <View style={styles.totalsRowFinal}>
            <Text style={styles.totalsLabelFinal}>Total Due (incl. GST)</Text>
            <Text style={styles.totalsValueFinal}>{money(data.totalInclGst)}</Text>
          </View>
        </View>

        {/* Payment + Notes boxes */}
        <View style={styles.boxRow}>
          <View style={styles.payBox}>
            <Text style={styles.boxLabel}>PAYMENT DETAILS</Text>
            {hasBank ? (
              <>
                {bank?.accountName ? <BoxLine label="Account name" value={bank.accountName} /> : null}
                {bank?.bankName ? <BoxLine label="Bank" value={bank.bankName} /> : null}
                {bank?.accountNumber ? <BoxLine label="Account number" value={bank.accountNumber} /> : null}
                <BoxLine label="Reference" value={data.invoiceNumber} />
              </>
            ) : (
              <Text style={styles.boxPlaceholder}>
                Add your bank account in Settings → Quote template and it will appear here.
              </Text>
            )}
          </View>
          {data.notes ? (
            <View style={styles.notesBox}>
              <Text style={styles.boxLabel}>NOTES</Text>
              <Text style={styles.notesText}>{data.notes}</Text>
            </View>
          ) : (
            // Keep the layout balanced when there are no notes.
            <View style={{ flex: 1 }} />
          )}
        </View>

        {/* Footer */}
        <Text style={styles.footerThanks} fixed>
          Thank you for your business — {businessName}
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

function BoxLine({ label, value }: { label: string; value: string }) {
  return (
    <Text style={styles.boxLine}>
      <Text style={styles.boxLineLabel}>{label}: </Text>
      {value}
    </Text>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString('en-NZ', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
