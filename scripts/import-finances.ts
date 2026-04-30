/**
 * import-finances.ts
 *
 * Reads the JSON dumps in TradePilot/data/import/ and loads them into Supabase.
 *
 *   pnpm tsx scripts/import-finances.ts            # dry run (default)
 *   pnpm tsx scripts/import-finances.ts --apply    # actually write to Supabase
 *   pnpm tsx scripts/import-finances.ts --apply --reset
 *       # truncate the imported tables first (jobs/entries/materials/quotes)
 *
 * Idempotent against re-runs because we upsert on legacy_id where possible.
 * Always run --apply --reset for the first import; afterwards, use --apply
 * alone to layer in new rows.
 *
 * Skips: Summary (derived), Inbox (empty), Settings (already seeded), Schedule
 * Items (we don't have a sheet equivalent).
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') });

// ─── Args ────────────────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

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

// ─── Paths ───────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = join(HERE, '..', 'data', 'import');

// ─── Type helpers ────────────────────────────────────────────────────────────
type Row = Record<string, string>;
type SheetFile = { worksheet: string; headers: string[]; rows: Row[]; row_count: number };

function loadSheet(slug: string): SheetFile {
  return JSON.parse(readFileSync(join(IMPORT_DIR, `${slug}.json`), 'utf8'));
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

/** Parse "$1,004.35", "-67", "" → number | null. Returns absolute value (no sign). */
function parseAmount(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n);
}

/** Parse "TRUE"/"FALSE"/"" → boolean | null */
function parseBool(raw: string | undefined | null): boolean | null {
  if (raw == null) return null;
  const v = String(raw).trim().toUpperCase();
  if (v === 'TRUE') return true;
  if (v === 'FALSE') return false;
  if (v === '') return null;
  return null;
}

/**
 * Parse mixed-format date strings into ISO YYYY-MM-DD.
 * Handles:
 *   - 2026-01-23           (ISO)
 *   - 1/26/2026            (M/D/YYYY — US style, our sheets default)
 *   - 2/14/2026 20:12:10   (with time, US style)
 *   - 20/03/2026           (D/M/YYYY — needs disambiguation)
 *
 * For ambiguous "DD/MM vs MM/DD" dates we use a hint:
 *  - if the first component > 12 it MUST be a day, so it's D/M/YYYY
 *  - otherwise we default to M/D/YYYY (which matches every other tab in the sheet)
 *
 * Returns null for unparseable input. Logs a warning if the date is suspect.
 */
function parseDate(raw: string | undefined | null, label = ''): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO already
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Slash-separated, possibly with time. Year may be 4 OR 2 digits — 4 first
  // so "2026" doesn't get truncated to "20".
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    let y = slash[3];
    if (y.length === 2) {
      // 2-digit year: < 70 → 20XX, >= 70 → 19XX. Brad's data is all 2020s.
      const yy = Number(y);
      y = String(yy < 70 ? 2000 + yy : 1900 + yy);
    }
    let month: number, day: number;
    if (a > 12) {
      // Must be D/M/YYYY
      day = a; month = b;
    } else if (b > 12) {
      // Must be M/D/YYYY
      month = a; day = b;
    } else {
      // Ambiguous — default to M/D/YYYY (matches the rest of the Finances sheet)
      month = a; day = b;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      console.warn(`  [warn] ${label}: implausible date ${s} (parsed month=${month}, day=${day})`);
      return null;
    }
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  console.warn(`  [warn] ${label}: unrecognised date format ${JSON.stringify(s)}`);
  return null;
}

// ─── Status / activity / category mappings ───────────────────────────────────

const JOB_STATUS_MAP: Record<string, string> = {
  'New':         'lead',
  'Accepted':    'accepted',
  'In progress': 'in-progress',
  'Completed':   'completed',
  'On Hold':     'lead', // closest fit; we don't have a real on-hold status yet
};

const QUOTE_STATUS_MAP: Record<string, string> = {
  'Draft':      'draft',
  'Sent':       'sent',
  'Accepted':   'accepted',
  'Won':        'accepted',
  'Declined':   'declined',
  'Lost':       'declined',
  'Expired':    'expired',
  'Superseded': 'superseded',
};

// Trade Pilot's allowed activities (must match schema CHECK constraint)
const ALLOWED_ACTIVITIES = new Set([
  'prep','painting','staining','wallpapering','stopping',
  'primer','repair','cleanup','travel','quoting','admin',
]);

// Map sheet activity names that don't match TP exactly
const ACTIVITY_ALIAS: Record<string, string> = {
  paint: 'painting',
  stain: 'staining',
  wallpaper: 'wallpapering',
};

const ALLOWED_CATEGORIES = new Set([
  'labour','paint','materials','tools','fuel','vehicle','admin',
  'software','marketing','subcontractor','other',
]);

const ALLOWED_PRODUCT_TYPES = new Set([
  'paint','primer','stain','filler','tape','sandpaper',
  'brush','roller','drop_sheet','caulk','wallpaper','other',
]);

const ALLOWED_FINISHES = new Set([
  'matte','flat','low_sheen','satin','semi_gloss','gloss','eggshell',
]);

const ALLOWED_UNITS = new Set([
  'litres','rolls','sheets','each','metres','kg',
]);

function normaliseEnum<T extends string>(
  raw: string | undefined,
  allowed: Set<T>,
  alias: Record<string, T> = {},
): T | null {
  if (!raw) return null;
  const k = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (alias[k]) return alias[k];
  if (allowed.has(k as T)) return k as T;
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function getBusinessId(): Promise<string> {
  const { data, error } = await sb
    .from('businesses')
    .select('id, name')
    .limit(2);
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('No business row found. Run supabase/seed.sql first.');
  }
  if (data.length > 1) {
    console.warn(`  [warn] Multiple businesses found, using "${data[0].name}" (${data[0].id})`);
  }
  return data[0].id;
}

async function reset(businessId: string) {
  console.log('Resetting imported tables (materials, quotes, entries, jobs)…');
  // Order matters because of FKs (materials.entry_id, materials.job_id, quotes.job_id, entries.job_id)
  for (const table of ['materials', 'quotes', 'entries', 'jobs']) {
    const { error } = await sb.from(table).delete().eq('business_id', businessId);
    if (error) throw new Error(`Reset ${table}: ${error.message}`);
  }
}

async function importJobs(businessId: string): Promise<Map<string, string>> {
  const sheet = loadSheet('jobs');
  const rows = sheet.rows;
  console.log(`\n📋 Jobs: ${rows.length} rows`);

  const records = rows
    .filter((r) => r['Job ID'])
    .map((r) => ({
      business_id: businessId,
      legacy_id: r['Job ID'],
      name: r['Job Name'] || '(unnamed)',
      client_name: r['Client Name'] || '(unknown)',
      location: r['Job Address'] || null,
      status: JOB_STATUS_MAP[r['Status']] || 'lead',
      quote_amount: parseAmount(r['Quoted Amount']),
      start_date: parseDate(r['Start Date (mm/dd/yyyy)'], `Job ${r['Job ID']} start_date`),
      notes: r['Notes'] || null,
    }));

  if (!APPLY) {
    console.log(`  (dry-run) would upsert ${records.length} jobs`);
    return new Map();
  }

  // Upsert on legacy_id
  const { data, error } = await sb
    .from('jobs')
    .upsert(records, { onConflict: 'legacy_id' })
    .select('id, legacy_id');
  if (error) throw new Error(`Jobs: ${error.message}`);

  const idMap = new Map<string, string>();
  for (const j of data ?? []) idMap.set(j.legacy_id, j.id);
  console.log(`  ✓ ${data?.length ?? 0} jobs upserted`);
  return idMap;
}

async function importTransactions(
  businessId: string,
  jobIdMap: Map<string, string>,
) {
  const sheet = loadSheet('transactions');
  const rows = sheet.rows;
  console.log(`\n💸 Transactions: ${rows.length} rows`);

  const records = rows
    .map((r, i) => {
      // Header for the timestamp column is "" (empty string).
      const tsRaw = r[''] || '';
      const dateRaw = r['Date'];
      const type = r['Type (income or expense)']?.toLowerCase().trim();
      if (type !== 'expense' && type !== 'income') {
        console.warn(`  [warn] tx ${i}: unknown type ${JSON.stringify(type)}, skipping`);
        return null;
      }
      const cat = r['Category']?.toLowerCase().trim();
      // 'income' as category isn't a valid TP category enum — null it out for income rows.
      const category = type === 'income' ? null : (ALLOWED_CATEGORIES.has(cat) ? cat : 'other');

      const jobLegacy = r['Job ID'];
      const jobId = jobLegacy && jobLegacy !== 'OH' ? jobIdMap.get(jobLegacy) : null;

      return {
        business_id: businessId,
        job_id: jobId,
        type,
        category,
        amount: parseAmount(r['Amount']),
        supplier: null,
        payment_method: r['Payment method'] || null,
        gst_applies: parseBool(r['GST applies?']) ?? false,
        amount_ex_gst: parseAmount(r['Amount ex GST']),
        gst_component: parseAmount(r['GST component']),
        description: r['Description'] || `(${type})`,
        entry_date: parseDate(dateRaw, `tx ${i} date`) || new Date().toISOString().slice(0, 10),
        // We don't have a created_at column override — but the timestamp from the
        // sheet is useful provenance; stuff it into description if non-empty.
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (!APPLY) {
    console.log(`  (dry-run) would insert ${records.length} entries`);
    return;
  }

  const { error } = await sb.from('entries').insert(records);
  if (error) throw new Error(`Transactions: ${error.message}`);
  console.log(`  ✓ ${records.length} transactions inserted as entries`);
}

async function importLoggedHours(
  businessId: string,
  jobIdMap: Map<string, string>,
) {
  const sheet = loadSheet('logged_hours');
  const rows = sheet.rows;
  console.log(`\n🕒 Logged Hours: ${rows.length} rows`);

  const records = rows
    .map((r, i) => {
      const jobLegacy = r['Job ID'];
      const jobId = jobLegacy && jobLegacy !== 'OH' ? jobIdMap.get(jobLegacy) : null;
      const activity = normaliseEnum(r['Activity'], ALLOWED_ACTIVITIES, ACTIVITY_ALIAS);
      const hours = parseAmount(r['Hours']);
      return {
        business_id: businessId,
        job_id: jobId,
        type: 'hours' as const,
        activity,
        hours,
        gst_applies: false,
        description: r['Notes'] || `${activity ?? 'work'} on ${jobLegacy ?? 'job'}`,
        entry_date: parseDate(r['Date'], `hours ${i} date`) || new Date().toISOString().slice(0, 10),
      };
    });

  if (!APPLY) {
    console.log(`  (dry-run) would insert ${records.length} hour entries`);
    return;
  }

  const { error } = await sb.from('entries').insert(records);
  if (error) throw new Error(`Logged Hours: ${error.message}`);
  console.log(`  ✓ ${records.length} hours entries inserted`);
}

async function importBills(
  businessId: string,
  jobIdMap: Map<string, string>,
) {
  const sheet = loadSheet('outstanding_bills');
  const rows = sheet.rows;
  console.log(`\n📄 Outstanding Bills: ${rows.length} rows`);

  const records = rows.map((r, i) => {
    const jobLegacy = r['Job ID'];
    const jobId = jobLegacy && jobLegacy !== 'OH' ? jobIdMap.get(jobLegacy) : null;
    return {
      business_id: businessId,
      job_id: jobId,
      type: 'bill' as const,
      amount: parseAmount(r['Amount']),
      gst_applies: parseBool(r['GST applies?']) ?? false,
      amount_ex_gst: parseAmount(r['Amount ex GST']),
      gst_component: parseAmount(r['GST component']),
      description: r['Description'] || `Bill from ${r['Company'] || 'unknown'}`,
      entry_date: parseDate(r['Date'], `bill ${i} date`) || new Date().toISOString().slice(0, 10),
      due_date: parseDate(r['Due date'], `bill ${i} due_date`),
      company: r['Company'] || null,
      paid: parseBool(r['Paid']) ?? false,
      paid_date: parseDate(r['Paid date'], `bill ${i} paid_date`),
      payment_ref: r['Payment ref'] || null,
    };
  });

  if (!APPLY) {
    console.log(`  (dry-run) would insert ${records.length} bills`);
    return;
  }

  const { error } = await sb.from('entries').insert(records);
  if (error) throw new Error(`Bills: ${error.message}`);
  console.log(`  ✓ ${records.length} bills inserted`);
}

async function importMaterials(
  businessId: string,
  jobIdMap: Map<string, string>,
) {
  const sheet = loadSheet('materials_and_paint');
  const rows = sheet.rows;
  console.log(`\n🎨 Materials & Paint: ${rows.length} rows`);

  const records = rows.map((r, i) => {
    const jobLegacy = r['Job ID'];
    const jobId = jobLegacy && jobLegacy !== 'OH' ? jobIdMap.get(jobLegacy) : null;
    return {
      business_id: businessId,
      job_id: jobId,
      used_on: parseDate(r['Date'], `material ${i} date`),
      product_type: normaliseEnum(r['Product Type'], ALLOWED_PRODUCT_TYPES),
      brand: r['Brand'] || null,
      product_name: r['Product Name'] || null,
      color: r['Color'] || null,
      finish: normaliseEnum(r['Finish'], ALLOWED_FINISHES),
      quantity: parseAmount(r['Quantity']),
      unit: normaliseEnum(r['Unit'], ALLOWED_UNITS),
      cost: parseAmount(r['Cost']),
      supplier: r['Supplier'] || null,
      area: r['Area/Room'] || null,
      notes: r['Notes'] || null,
    };
  });

  if (!APPLY) {
    console.log(`  (dry-run) would insert ${records.length} materials`);
    return;
  }

  const { error } = await sb.from('materials').insert(records);
  if (error) throw new Error(`Materials: ${error.message}`);
  console.log(`  ✓ ${records.length} materials inserted`);
}

async function importQuotes(
  businessId: string,
  jobIdMap: Map<string, string>,
) {
  const sheet = loadSheet('quotes');
  const rows = sheet.rows;
  console.log(`\n📝 Quotes: ${rows.length} rows`);

  const records = rows
    .filter((r) => r['Quote ID'])
    .map((r, i) => {
      const jobLegacy = r['Job ID'];
      const jobId = jobLegacy ? jobIdMap.get(jobLegacy) ?? null : null;
      const baseEx = parseAmount(r['Base Quote (excl. GST)']);
      const optionEx = parseAmount(r['Option Quote (excl. GST)']);
      const totalIncl = parseAmount(r['Total Quote (incl. GST)']);
      return {
        business_id: businessId,
        legacy_id: r['Quote ID'],
        legacy_enquiry_id: r['Enquiry ID'] || null,
        job_id: jobId,
        date_sent: parseDate(r['Date Sent'], `quote ${i} date_sent`),
        client_name: r['Client Name'] || null,
        job_address: r['Job Address'] || null,
        job_type: r['Job Type'] || null,
        scope_summary: r['Scope Summary'] || null,
        base_amount_ex_gst: baseEx,
        option_amount_ex_gst: optionEx,
        total_amount_incl_gst: totalIncl,
        status: QUOTE_STATUS_MAP[r['Status']?.trim() ?? ''] ?? 'sent',
        won_amount_ex_gst: parseAmount(r['Won Amount (excl. GST)']),
        variance_amount: parseAmount(r['Variance $']),
        variance_percent: parseAmount(r['Variance %']),
        notes: r['Notes'] || null,
      };
    });

  if (!APPLY) {
    console.log(`  (dry-run) would upsert ${records.length} quotes`);
    return;
  }

  const { error } = await sb
    .from('quotes')
    .upsert(records, { onConflict: 'legacy_id' });
  if (error) throw new Error(`Quotes: ${error.message}`);
  console.log(`  ✓ ${records.length} quotes upserted`);
}

async function main() {
  console.log('Trade Pilot importer');
  console.log(`  Mode: ${APPLY ? 'APPLY (writing to Supabase)' : 'DRY RUN (no writes)'}`);
  if (RESET) console.log('  --reset: will truncate jobs/entries/materials/quotes for this business first');

  // Show what files we have
  console.log(`\n  Import dir: ${IMPORT_DIR}`);
  console.log(`  Files: ${readdirSync(IMPORT_DIR).filter((f) => f.endsWith('.json')).join(', ')}`);

  const businessId = await getBusinessId();
  console.log(`\nBusiness id: ${businessId}`);

  if (RESET && APPLY) {
    await reset(businessId);
  }

  const jobIdMap = await importJobs(businessId);
  await importTransactions(businessId, jobIdMap);
  await importLoggedHours(businessId, jobIdMap);
  await importBills(businessId, jobIdMap);
  await importMaterials(businessId, jobIdMap);
  await importQuotes(businessId, jobIdMap);

  console.log('\n✅ Done.');
  if (!APPLY) {
    console.log('   (Dry run — no data was written. Re-run with --apply to commit.)');
  }
}

main().catch((err) => {
  console.error('\n❌ Import failed:', err.message);
  process.exit(1);
});
