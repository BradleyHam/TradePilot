/**
 * Bank-transaction classifier.
 *
 * Given a parsed bank row, returns a best-guess of:
 *   - what kind of entry it should become (expense / income / personal / transfer)
 *   - which category, if expense
 *   - which job, if applicable
 *   - confidence: 'high' | 'medium' | 'low'
 *
 * The classifier blends two signal sources:
 *   1. Hardcoded keyword rules (BP, Mitre 10, Resene, etc → known mappings).
 *      These cover the common merchants for a NZ painter without any data.
 *   2. The user's own historical entries — if "RESENE" appears 18 times in
 *      past expenses tagged 'paint', a new RESENE row is almost certainly
 *      paint too. Learned weights override hardcoded defaults.
 *
 * Out of scope tonight:
 *   - Job-id assignment by recency (would default to the most recently
 *     touched active job for material/paint expenses). Built later.
 *   - Pattern-learning across description fragments (e.g. "fuel +
 *     amount around $80" → fuel, even with new petrol stations).
 */

import type { Entry, ExpenseCategory, EntryType } from './types';
import type { ParsedBankRow } from './bank-csv';

export type Suggestion =
  | { kind: 'expense'; category: ExpenseCategory; supplier?: string; confidence: Confidence }
  | { kind: 'income';  confidence: Confidence }
  | { kind: 'personal'; reason: string; confidence: Confidence }
  | { kind: 'transfer'; reason: string; confidence: Confidence }
  | { kind: 'unknown'; confidence: 'low' };

export type Confidence = 'high' | 'medium' | 'low';

// ── Keyword rules for common NZ painter merchants ──────────────────────────
// Patterns are lowercase substring matches against payee + particulars.

interface Rule {
  pattern: RegExp;
  category?: ExpenseCategory;
  kind: 'expense' | 'income' | 'personal' | 'transfer';
  supplier?: string;
  reason?: string;
}

const RULES: Rule[] = [
  // Fuel
  { pattern: /\b(bp connect|bp \w|z energy|z station|caltex|mobil|gull|waitomo|allied)\b/, kind: 'expense', category: 'fuel', supplier: 'Fuel station' },
  // Paint suppliers
  { pattern: /\bresene\b/, kind: 'expense', category: 'paint', supplier: 'Resene' },
  { pattern: /\bdulux\b/, kind: 'expense', category: 'paint', supplier: 'Dulux' },
  { pattern: /\bporter'?s?\b/, kind: 'expense', category: 'paint', supplier: 'Porter\'s' },
  // Hardware / materials
  { pattern: /\bmitre ?10\b/, kind: 'expense', category: 'materials', supplier: 'Mitre 10' },
  { pattern: /\bbunnings\b/, kind: 'expense', category: 'materials', supplier: 'Bunnings' },
  { pattern: /\bplace makers?\b/, kind: 'expense', category: 'materials', supplier: 'PlaceMakers' },
  { pattern: /\bitm\b/, kind: 'expense', category: 'materials', supplier: 'ITM' },
  // Vehicle
  { pattern: /\b(vtnz|nzta|wof|warrant|rego|registration|repco)\b/, kind: 'expense', category: 'vehicle' },
  // Software
  { pattern: /\b(xero|claude\.ai|anthropic|google workspace|notion|figma|github|cursor|vercel|supabase|stripe)\b/, kind: 'expense', category: 'software' },
  // Marketing
  { pattern: /\b(facebook|meta|google ads|canva|mailchimp)\b/, kind: 'expense', category: 'marketing' },

  // Internal transfers — BNZ shows these as "Savings" / "YouMoney" / "Taxes"
  // payees with tran_type=FT. The user can re-classify but defaulting these
  // to ignored saves a lot of clicks.
  { pattern: /^(savings|taxes|youmoney|tax|gst)$/i, kind: 'transfer', reason: 'Looks like an internal transfer' },

  // Common personal — barbershops, supermarkets, hospitality, etc.
  // Erring conservative: only mark obvious ones, leave grey areas for review.
  { pattern: /\b(barber|hair salon|salon|haircut)\b/, kind: 'personal', reason: 'Personal grooming' },
  { pattern: /\b(pak ?n ?save|countdown|new world|four square)\b/, kind: 'personal', reason: 'Supermarket' },
  { pattern: /\b(uber eats|menulog|deliveroo|hello fresh|my food bag)\b/, kind: 'personal', reason: 'Food delivery' },
  { pattern: /\b(spotify|netflix|disney|amazon prime|apple\.com\/bill)\b/, kind: 'personal', reason: 'Streaming subscription' },
];

// ── Public API ──────────────────────────────────────────────────────────────

export interface ClassifierContext {
  /** All historical entries. Used to learn supplier→category mappings. */
  entries: Entry[];
}

/**
 * Build a per-supplier histogram from the user's history. Any time the same
 * supplier name appears in multiple expenses, we tally categories. The top
 * category for that supplier becomes a strong hint for new transactions.
 */
function buildSupplierIndex(entries: Entry[]): Map<string, { category: ExpenseCategory; n: number }> {
  const counts = new Map<string, Map<ExpenseCategory, number>>();
  for (const e of entries) {
    if (e.type !== 'expense' || !e.supplier || !e.category) continue;
    const key = e.supplier.trim().toLowerCase();
    if (!key) continue;
    const inner = counts.get(key) ?? new Map();
    inner.set(e.category, (inner.get(e.category) ?? 0) + 1);
    counts.set(key, inner);
  }
  // Pick the top category per supplier
  const result = new Map<string, { category: ExpenseCategory; n: number }>();
  for (const [supplier, byCat] of counts) {
    let bestCat: ExpenseCategory | null = null;
    let bestN = 0;
    for (const [cat, n] of byCat) {
      if (n > bestN) { bestCat = cat; bestN = n; }
    }
    if (bestCat) result.set(supplier, { category: bestCat, n: bestN });
  }
  return result;
}

export function classifyBankRow(
  row: ParsedBankRow,
  ctx: ClassifierContext,
): Suggestion {
  const haystack = [row.payee, row.particulars, row.reference, row.description]
    .filter(Boolean).join(' ').toLowerCase();
  const payeeOnly = (row.payee ?? '').trim().toLowerCase();

  // ── Internal transfers ──────────────────────────────────────────────────
  // BNZ marks money moved between your own accounts as tran_type 'FT' (Funds
  // Transfer). Treat these as transfers by default — Brad does this every
  // time income lands (move % to tax savings, % to actual savings, etc).
  // Catches the case the regex-only rules missed (e.g. "Taxes · INTERNET XFR"
  // doesn't match `^taxes$` against the joined haystack).
  if (row.tranType === 'FT') {
    return {
      kind: 'transfer',
      reason: payeeOnly === 'savings' ? 'Transfer to savings'
        : payeeOnly === 'taxes' ? 'Transfer to tax account'
        : payeeOnly ? `Transfer to ${row.payee}`
        : 'Internal transfer',
      confidence: 'high',
    };
  }

  // Income — positive amounts that aren't internal transfers
  if (row.amount > 0) {
    // Heuristic: income from customers usually has a person/company name and
    // a reference like "INV", "DEPOSIT", "Q###", etc.
    const looksLikeCustomer =
      /\b(inv|deposit|q\d{2,}|invoice|payment|paid)\b/i.test(haystack);
    return {
      kind: 'income',
      confidence: looksLikeCustomer ? 'high' : 'medium',
    };
  }

  // Negative amounts — apply rules in order. Each rule tries the payee field
  // alone first (so anchored patterns like `^(savings|taxes)$` work) and
  // then the full haystack.
  for (const rule of RULES) {
    const matches = rule.pattern.test(payeeOnly) || rule.pattern.test(haystack);
    if (matches) {
      if (rule.kind === 'expense') {
        return {
          kind: 'expense',
          category: rule.category!,
          supplier: rule.supplier,
          confidence: 'high',
        };
      }
      if (rule.kind === 'transfer') {
        return { kind: 'transfer', reason: rule.reason ?? 'Internal transfer', confidence: 'high' };
      }
      if (rule.kind === 'personal') {
        return { kind: 'personal', reason: rule.reason ?? 'Personal', confidence: 'medium' };
      }
    }
  }

  // No hardcoded match — try learned suppliers
  const supplierIdx = buildSupplierIndex(ctx.entries);
  // Best fuzzy match: if the row's payee is a substring of a known supplier
  // (or vice versa), we'll accept it.
  if (row.payee) {
    const payeeLower = row.payee.trim().toLowerCase();
    for (const [supplier, info] of supplierIdx) {
      if (payeeLower.includes(supplier) || supplier.includes(payeeLower)) {
        return {
          kind: 'expense',
          category: info.category,
          supplier: row.payee,
          confidence: info.n >= 3 ? 'high' : 'medium',
        };
      }
    }
  }

  // Last resort — call it an expense, low confidence
  if (row.amount < 0) {
    return { kind: 'expense', category: 'other', supplier: row.payee, confidence: 'low' };
  }

  return { kind: 'unknown', confidence: 'low' };
}

/**
 * Try to find an existing entry that matches this bank row.
 * A match means: same date (±2 days), same gross amount (±$0.10), and the
 * same direction (income vs expense). Returns the best candidate or null.
 */
export function findMatchingEntry(
  row: ParsedBankRow,
  entries: Entry[],
): Entry | null {
  const targetAmount = Math.abs(row.amount);
  const targetType: EntryType = row.amount > 0 ? 'income' : 'expense';
  const txnTime = new Date(row.txnDate + 'T00:00:00').getTime();

  let best: Entry | null = null;
  let bestDiff = Infinity;

  for (const e of entries) {
    if (e.bankTransactionId) continue; // already linked elsewhere
    if (e.amount == null) continue;

    // Type filter — bills can also be matched against negative bank txns
    // because paying a bill IS an expense from the bank's POV.
    const typeMatches = (e.type === targetType)
      || (targetType === 'expense' && e.type === 'bill' && e.paid);
    if (!typeMatches) continue;

    // Amount within 10c
    if (Math.abs(e.amount - targetAmount) > 0.10) continue;

    // Date within 2 days
    const eTime = new Date(e.entryDate + 'T00:00:00').getTime();
    const diffDays = Math.abs(txnTime - eTime) / 86_400_000;
    if (diffDays > 2) continue;

    if (diffDays < bestDiff) {
      best = e;
      bestDiff = diffDays;
    }
  }
  return best;
}
