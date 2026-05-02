/**
 * BNZ CSV parser.
 *
 * BNZ exports look like:
 *   Date,Amount,Payee,Particulars,Code,Reference,Tran Type,This Party Account,
 *     Other Party Account,Serial,Transaction Code,Batch Number,
 *     Originating Bank/Branch,Processed Date
 *   26/04/26,-112.06,BP CONNECT WANAKA,5996,WANAKA,492102260916,POS,...
 *
 * We parse to a row shape that matches the `bank_transactions` table.
 *
 * Other NZ banks (ANZ, ASB, Westpac, Kiwibank) have similar but different
 * formats. For now this only handles BNZ — `detectBank()` returns `'bnz'` if
 * it sees BNZ's column names; otherwise we'd add other parsers later.
 */

export type Bank = 'bnz' | 'unknown';

export interface ParsedBankRow {
  txnDate: string;            // YYYY-MM-DD
  amount: number;             // signed: negative for debits
  payee?: string;
  particulars?: string;
  code?: string;
  reference?: string;
  tranType?: string;
  otherPartyAccount?: string;
  description: string;        // derived, used for matching/display
  /** Stable hash so re-imports of the same CSV don't duplicate. */
  fingerprint: string;
}

const BNZ_HEADERS = ['date','amount','payee','particulars','code','reference','tran type'];

/** Sniff which bank's format this CSV looks like, by checking the header row. */
export function detectBank(headerRow: string[]): Bank {
  const lower = headerRow.map((h) => h.trim().toLowerCase());
  // BNZ: must have all of Date, Amount, Payee, Particulars in first few cols
  if (BNZ_HEADERS.every((h) => lower.includes(h))) return 'bnz';
  return 'unknown';
}

/**
 * Parse a single CSV line into fields, handling BNZ's quoted values.
 * Doesn't use a full CSV library (overkill) — handles the cases BNZ actually
 * exports: comma-separated, quoted strings, no embedded commas in payees.
 */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** BNZ "26/04/26" → "2026-04-26" */
function parseBnzDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  let year = m[3];
  if (year.length === 2) {
    const yy = Number(year);
    year = String(yy < 70 ? 2000 + yy : 1900 + yy);
  }
  return `${year}-${month}-${day}`;
}

/** Compose a useful display description from BNZ's various description-ish columns. */
function deriveDescription(payee?: string, particulars?: string, reference?: string): string {
  const parts = [payee, particulars, reference]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0 && !/^\d+$/.test(s)); // drop pure-numeric noise
  // De-dupe in case same string appears in two columns
  const seen = new Set<string>();
  const dedup = parts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return dedup.join(' · ') || 'Unknown';
}

/** Stable fingerprint for idempotency — date + amount + raw description. */
function fingerprintOf(date: string, amount: number, payee: string, particulars: string, reference: string): string {
  const raw = `${date}|${amount.toFixed(2)}|${payee}|${particulars}|${reference}`;
  // Cheap hash — DJB2. Collisions vanishingly unlikely across one user's data.
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export interface ParseResult {
  bank: Bank;
  rows: ParsedBankRow[];
  errors: { line: number; message: string; raw: string }[];
}

export function parseBnzCsv(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/﻿/g, ''))   // strip BOM
    .filter((l, i) => l.length > 0 || i === 0); // keep header even if empty
  if (lines.length === 0) {
    return { bank: 'unknown', rows: [], errors: [{ line: 0, message: 'Empty file', raw: '' }] };
  }
  const headers = splitCsv(lines[0]);
  const bank = detectBank(headers);
  if (bank !== 'bnz') {
    return { bank, rows: [], errors: [{
      line: 1,
      message: `Couldn't detect a known bank format. First column was '${headers[0] ?? ''}'.`,
      raw: lines[0],
    }] };
  }

  const idx = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name);
  const colDate    = idx('date');
  const colAmount  = idx('amount');
  const colPayee   = idx('payee');
  const colPart    = idx('particulars');
  const colCode    = idx('code');
  const colRef     = idx('reference');
  const colTran    = idx('tran type');
  const colOther   = idx('other party account');

  const rows: ParsedBankRow[] = [];
  const errors: ParseResult['errors'] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitCsv(line);
    const dateStr = cells[colDate];
    const amountStr = cells[colAmount];
    if (!dateStr || amountStr == null) {
      errors.push({ line: i + 1, message: 'Missing date or amount', raw: line });
      continue;
    }
    const date = parseBnzDate(dateStr);
    if (!date) {
      errors.push({ line: i + 1, message: `Unrecognised date '${dateStr}'`, raw: line });
      continue;
    }
    const amount = Number(amountStr.replace(/[, ]/g, ''));
    if (!Number.isFinite(amount)) {
      errors.push({ line: i + 1, message: `Bad amount '${amountStr}'`, raw: line });
      continue;
    }
    const payee = (cells[colPayee] ?? '').trim();
    const particulars = (cells[colPart] ?? '').trim();
    const code = (cells[colCode] ?? '').trim();
    const reference = (cells[colRef] ?? '').trim();
    const tranType = (cells[colTran] ?? '').trim();
    const otherParty = (cells[colOther] ?? '').trim();

    rows.push({
      txnDate: date,
      amount,
      payee:        payee || undefined,
      particulars:  particulars || undefined,
      code:         code || undefined,
      reference:    reference || undefined,
      tranType:     tranType || undefined,
      otherPartyAccount: otherParty || undefined,
      description:  deriveDescription(payee, particulars, reference),
      fingerprint:  fingerprintOf(date, amount, payee, particulars, reference),
    });
  }

  return { bank, rows, errors };
}
