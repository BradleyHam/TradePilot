/**
 * diff-sheet-vs-supabase.ts
 *
 * One-off cross-reference between Brad's "Business Data — Transactions"
 * Google Sheet (exported as CSV) and the entries table in Supabase.
 *
 * Output: three lists
 *   1. MATCHED       — sheet row + corresponding entry row (date + amount + type).
 *   2. SHEET-ONLY    — in the sheet but not in Supabase. THESE ARE THE GAPS.
 *   3. SUPABASE-ONLY — in Supabase but not in the sheet (informational only —
 *                      anything post-Apr 26 lives only in the app and is fine).
 *
 * Match criteria:
 *   - Same direction (income vs expense — sign of amount and type match)
 *   - Same gross amount within $0.50 (accounts for GST rounding differences)
 *   - Same date within ±3 days (some rows in the sheet got logged a few days
 *     after the actual transaction date and the importer may have used the
 *     entry timestamp rather than the txn date)
 *
 * Usage on Brad's Mac:
 *
 *   1. Export the Transactions tab of the Sheet as CSV.
 *   2. Save the CSV somewhere local — e.g. ~/Downloads/transactions.csv
 *   3. Run:
 *
 *      npx tsx scripts/diff-sheet-vs-supabase.ts \
 *        --csv "/Users/bradleyhamilton/Downloads/transactions.csv"
 *
 *      Optional filters:
 *        --from 2026-01-01   only consider rows on/after this date
 *        --to   2026-04-30   only consider rows on/before this date
 *        --verbose           print every match (default: only print gaps + summary)
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Service-role key bypasses RLS so we see every entry.
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, '..', '.env.local') });

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  // also accept --name=value
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}
const CSV_PATH = flag('--csv');
const FROM = flag('--from'); // YYYY-MM-DD
const TO = flag('--to');     // YYYY-MM-DD
const VERBOSE = args.includes('--verbose');
const MATCH_AMOUNT_TOLERANCE = 0.50; // $
const MATCH_DAY_WINDOW = 3;          // ± days

if (!CSV_PATH) {
  console.error('Missing --csv <path>. See header comment for usage.');
  process.exit(1);
}

// ─── Supabase ────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Types ───────────────────────────────────────────────────────────────────
interface SheetRow {
  // Sheet's first column is the row's log-timestamp (when it was entered).
  // The "Date" column is the actual transaction date.
  loggedAt: string;
  date: string;        // YYYY-MM-DD (normalised)
  jobId: string;
  type: 'income' | 'expense';
  category: string;
  amount: number;      // signed — negative for expense
  description: string;
  paymentMethod: string;
  gstApplies: string;
  amountExGst: number;
  gstComponent: number;
  // Diagnostics
  raw: Record<string, string>;
  rowIndex: number;
}

interface EntryRow {
  id: string;
  entry_date: string;  // YYYY-MM-DD from DB
  type: string;
  amount: number | null;
  amount_ex_gst: number | null;
  description: string | null;
  job_id: string | null;
  is_draft: boolean | null;
}

// ─── CSV parsing ─────────────────────────────────────────────────────────────
function parseCSV(text: string): SheetRow[] {
  // Minimal CSV reader — handles quoted fields and embedded commas.
  // Doesn't handle escaped quotes inside quoted fields, but that's not in
  // Brad's sheet (descriptions are simple text).
  const lines: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cell += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { cur.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (cell || cur.length) { cur.push(cell); lines.push(cur); cur = []; cell = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else cell += c;
  }
  if (cell || cur.length) { cur.push(cell); lines.push(cur); }

  if (lines.length === 0) return [];
  const header = lines[0];
  const idx = (name: string) => header.findIndex((h) => h.trim() === name);
  const iLogged = 0; // first column is the log timestamp, no header name
  const iDate = idx('Date');
  const iJob = idx('Job ID');
  const iType = idx('Type (income or expense)');
  const iCat = idx('Category');
  const iAmt = idx('Amount');
  const iDesc = idx('Description');
  const iPM = idx('Payment method');
  const iGstA = idx('GST applies?');
  const iExGst = idx('Amount ex GST');
  const iGstC = idx('GST component');

  const out: SheetRow[] = [];
  for (let r = 1; r < lines.length; r++) {
    const row = lines[r];
    if (row.every((c) => !c.trim())) continue; // blank line
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { raw[h.trim() || `col${i}`] = (row[i] ?? '').trim(); });
    const dateNorm = normaliseDate(row[iDate] ?? '');
    const amt = parseFloat(row[iAmt] ?? '');
    if (!dateNorm || Number.isNaN(amt)) continue; // skip unusable rows
    out.push({
      loggedAt: row[iLogged] ?? '',
      date: dateNorm,
      jobId: (row[iJob] ?? '').trim(),
      type: (row[iType] ?? '').trim() === 'income' ? 'income' : 'expense',
      category: (row[iCat] ?? '').trim(),
      amount: amt,
      description: (row[iDesc] ?? '').trim(),
      paymentMethod: (row[iPM] ?? '').trim(),
      gstApplies: (row[iGstA] ?? '').trim(),
      amountExGst: parseFloat(row[iExGst] ?? '') || 0,
      gstComponent: parseFloat(row[iGstC] ?? '') || 0,
      raw,
      rowIndex: r + 1, // 1-based, including header
    });
  }
  return out;
}

function normaliseDate(s: string): string | null {
  if (!s) return null;
  s = s.trim();
  // YYYY-MM-DD
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // M/D/YYYY or MM/DD/YYYY (Sheet's other format)
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// ─── Match logic ─────────────────────────────────────────────────────────────
function daysBetween(a: string, b: string): number {
  const ad = new Date(`${a}T00:00:00`);
  const bd = new Date(`${b}T00:00:00`);
  return Math.abs((ad.getTime() - bd.getTime()) / 86_400_000);
}

/**
 * Try to find the best Supabase entry that matches a sheet row.
 * Returns the matched entry or null. Removes the matched entry from the
 * available pool (mutates) so the same entry doesn't get claimed twice.
 */
function findMatch(sheet: SheetRow, pool: EntryRow[]): EntryRow | null {
  const sheetAmtAbs = Math.abs(sheet.amount);
  let best: { entry: EntryRow; idx: number; score: number } | null = null;

  for (let i = 0; i < pool.length; i++) {
    const e = pool[i];
    if (e.is_draft) continue;

    // Type must match (sheet "income" → entries.type "income";
    // sheet "expense" → entries.type "expense" OR "bill")
    const entryType = e.type;
    const sheetType = sheet.type;
    const typeOk = sheetType === entryType
      || (sheetType === 'expense' && (entryType === 'expense' || entryType === 'bill'));
    if (!typeOk) continue;

    if (e.amount == null) continue;
    const entryAmtAbs = Math.abs(e.amount);
    if (Math.abs(entryAmtAbs - sheetAmtAbs) > MATCH_AMOUNT_TOLERANCE) continue;

    const dDays = daysBetween(sheet.date, e.entry_date);
    if (dDays > MATCH_DAY_WINDOW) continue;

    // Score: prefer same-day matches; tiebreak on amount closeness.
    const score = dDays * 10 + Math.abs(entryAmtAbs - sheetAmtAbs);
    if (best === null || score < best.score) {
      best = { entry: e, idx: i, score };
    }
  }
  if (best) {
    pool.splice(best.idx, 1);
    return best.entry;
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nReading CSV from ${CSV_PATH} …`);
  const csvText = readFileSync(CSV_PATH!, 'utf-8');
  let sheetRows = parseCSV(csvText);
  console.log(`  → ${sheetRows.length} parseable rows`);

  if (FROM) sheetRows = sheetRows.filter((r) => r.date >= FROM);
  if (TO) sheetRows = sheetRows.filter((r) => r.date <= TO);
  if (FROM || TO) {
    console.log(`  → ${sheetRows.length} rows after applying --from/--to filter`);
  }

  // Date bounds we'll use to pull a matching Supabase window.
  const sheetMinDate = sheetRows.reduce((min, r) => r.date < min ? r.date : min, '9999-12-31');
  const sheetMaxDate = sheetRows.reduce((max, r) => r.date > max ? r.date : max, '0000-01-01');
  // Widen by the match-day window on both ends so we don't miss edge matches.
  const queryFrom = shiftDate(sheetMinDate, -MATCH_DAY_WINDOW);
  const queryTo = shiftDate(sheetMaxDate, MATCH_DAY_WINDOW);

  console.log(`\nFetching Supabase entries between ${queryFrom} and ${queryTo} …`);
  const { data, error } = await sb
    .from('entries')
    .select('id, entry_date, type, amount, amount_ex_gst, description, job_id, is_draft')
    .gte('entry_date', queryFrom)
    .lte('entry_date', queryTo)
    .order('entry_date', { ascending: true });
  if (error) {
    console.error('Supabase query failed:', error.message);
    process.exit(1);
  }
  const allEntries = (data ?? []) as EntryRow[];
  console.log(`  → ${allEntries.length} entries in range`);
  console.log(`  → ${allEntries.filter((e) => e.is_draft).length} of those are drafts (will be excluded from matching)`);

  // Filter pool to only entry types we'd match against (income/expense/bill).
  const pool = allEntries.filter((e) =>
    e.type === 'income' || e.type === 'expense' || e.type === 'bill',
  );
  const initialPoolSize = pool.length;

  // ── Match each sheet row ──────────────────────────────────────────────────
  const matched: { sheet: SheetRow; entry: EntryRow }[] = [];
  const sheetOnly: SheetRow[] = [];

  for (const sr of sheetRows) {
    const m = findMatch(sr, pool);
    if (m) matched.push({ sheet: sr, entry: m });
    else sheetOnly.push(sr);
  }

  // Whatever's left in pool = Supabase entries with no matching sheet row.
  // For the date range we queried, these are "in app but not in sheet".
  const supabaseOnly = pool;

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n─── Summary ──────────────────────────────────────────────────`);
  console.log(`Sheet rows considered      : ${sheetRows.length}`);
  console.log(`Supabase entries in window : ${initialPoolSize} (post-draft filter)`);
  console.log(`Matched                    : ${matched.length}`);
  console.log(`In SHEET but not in app    : ${sheetOnly.length}  ← ⚠ these are the gaps`);
  console.log(`In app but not in sheet    : ${supabaseOnly.length}  ← (informational)`);

  if (sheetOnly.length > 0) {
    console.log(`\n─── Missing from TradePilot (sheet rows with no Supabase match) ───`);
    console.log(`(Run with --verbose to see all; below grouped by month.)`);
    const byMonth: Record<string, SheetRow[]> = {};
    for (const r of sheetOnly) {
      const key = r.date.slice(0, 7);
      (byMonth[key] ??= []).push(r);
    }
    for (const key of Object.keys(byMonth).sort()) {
      const rows = byMonth[key];
      const total = rows.reduce((s, r) => s + r.amount, 0);
      console.log(`\n${key} — ${rows.length} missing row(s), net $${total.toFixed(2)}:`);
      for (const r of rows) {
        const sign = r.type === 'income' ? '+' : '';
        console.log(`  ${r.date}  ${r.type.padEnd(7)}  ${r.jobId.padEnd(4)}  ${sign}$${r.amount.toFixed(2).padStart(9)}  ${r.category.padEnd(12)}  ${r.description.slice(0, 50)}`);
      }
    }
  }

  if (VERBOSE && matched.length > 0) {
    console.log(`\n─── Matched (verbose) ──────────────────────────────────────`);
    for (const { sheet, entry } of matched) {
      console.log(`  ✓ ${sheet.date} $${sheet.amount.toFixed(2)} ⇄ ${entry.entry_date} $${entry.amount} (id=${entry.id.slice(0, 8)}) ${sheet.description.slice(0, 40)}`);
    }
  }

  if (supabaseOnly.length > 0 && VERBOSE) {
    console.log(`\n─── In Supabase but not in Sheet (verbose) ────────────────`);
    for (const e of supabaseOnly) {
      const desc = (e.description ?? '').slice(0, 50);
      console.log(`  ${e.entry_date} ${e.type.padEnd(7)} $${(e.amount ?? 0).toFixed(2).padStart(9)}  ${desc}`);
    }
  }

  console.log(``);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
