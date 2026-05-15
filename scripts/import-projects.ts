/**
 * import-projects.ts
 *
 * Walks /Users/bradleyhamilton/Desktop/lakeside-painting/projects (or a
 * configurable path), identifies each per-job folder, matches it to an
 * existing `jobs` row, classifies the files, and either prints a dry-run
 * report (default) or stages the import via the `job_imports` table for
 * user review on Home (--apply).
 *
 * The --apply step is non-destructive to real tables:
 *   - Inserts/updates one row per folder in `job_imports` (NOT `jobs` or
 *     `quotes` yet). Status = 'pending'.
 *   - Uploads selected attachments (plans + a sample of photos) to the
 *     `quote-attachments` bucket under a `_pending/{importId}/` prefix.
 *   - Parses any quote PDF in the folder via Anthropic and stores the
 *     extracted fields in `job_imports.parsed_data` for later review.
 *
 * The user then opens Home, sees "X imports to review" in the Flags
 * card, expands it, and per-row taps Link / Create / Skip. The commit
 * step (in the app, not here) copies the staged data into the real
 * `jobs`/`quotes`/`quote_attachments` tables.
 *
 *   npx tsx scripts/import-projects.ts
 *     dry run, prints the proposed action per folder + writes the
 *     mapping CSV alongside the script
 *
 *   npx tsx scripts/import-projects.ts --projects-dir=/path/to/projects
 *     override the input folder if not at the default
 *
 *   npx tsx scripts/import-projects.ts --apply
 *     write job_imports rows + upload files. Idempotent on re-run:
 *     existing imports get UPDATED rather than duplicated.
 *
 *   npx tsx scripts/import-projects.ts --apply --limit=N
 *     only process the first N folders (useful for incremental testing)
 *
 * Match strategy per folder, in order:
 *   1. Scan invoice filenames for a J-ID pattern (e.g. INV-J12-*.pdf
 *      OR INV-027-J13-*.pdf). High-confidence hit.
 *   2. If no J-ID found, fuzzy-match folder name against
 *      jobs.name + jobs.location + jobs.client_name. Score >= threshold
 *      = medium confidence; below = low/no match.
 *   3. Anything ambiguous is reported. --apply still stages it as
 *      pending with low/none confidence so the user can decide in-app.
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import { parseQuoteText } from '../lib/quote-parser';
import type { FolderFileCounts, ParsedQuote } from '../lib/types';

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, '..', '.env.local') });

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const projectsDirArg = args.find((a) => a.startsWith('--projects-dir='));
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;
const DEFAULT_PROJECTS_DIR = '/Users/bradleyhamilton/Desktop/lakeside-painting/projects';
const PROJECTS_DIR = projectsDirArg
  ? projectsDirArg.slice('--projects-dir='.length)
  : DEFAULT_PROJECTS_DIR;

// Photos per folder we'll upload. Plans are always all uploaded; photos
// we sample down to keep Storage usage reasonable (per the earlier scope
// decision: "plans + before/after photos only, ~100-150 files total").
const MAX_PHOTOS_PER_IMPORT = 4;
// Max file size we'll bother uploading. PDFs/photos over this skip.
const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB

// ─── Supabase ────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUSINESS_ID = process.env.TRADEPILOT_BUSINESS_ID!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
if (APPLY && !BUSINESS_ID) {
  console.error('Missing TRADEPILOT_BUSINESS_ID in .env.local (required for --apply)');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── File classification ─────────────────────────────────────────────────────
// Maps a filename → what kind of file it is from a quote-attachments POV.
// Used to decide which files to upload and how to tag them in the
// quote_attachments table.

type FileKind =
  | 'plan'            // council plan / floor plan / elevation
  | 'quote_pdf'       // a sent quote document
  | 'invoice_pdf'     // an invoice (not imported as attachment — already in invoices table)
  | 'before_photo'    // photo that looks like 'before' (heuristic)
  | 'after_photo'     // photo that looks like 'after' (heuristic)
  | 'scope_photo'     // generic site photo
  | 'notes_md'        // markdown notes file
  | 'video'           // mov/mp4
  | 'spreadsheet'     // xlsx etc
  | 'other';

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp']);
const VIDEO_EXTS = new Set(['.mov', '.mp4']);
const SHEET_EXTS = new Set(['.xlsx', '.xls', '.csv']);

function classifyFile(filename: string): FileKind {
  const lower = filename.toLowerCase();
  const ext = extname(lower);

  // PDF kinds first (most signal in filename).
  if (ext === '.pdf') {
    if (lower.includes('plan') || lower.includes('consent') || lower.includes('drawing')) return 'plan';
    if (lower.startsWith('inv-') || lower.includes('invoice')) return 'invoice_pdf';
    if (lower.startsWith('q-') || lower.includes('quote')) return 'quote_pdf';
    return 'other';
  }
  if (ext === '.docx' && (lower.includes('quote') || lower.startsWith('q-'))) return 'quote_pdf';

  // Photo classification — heuristic only. Folder may also have explicit
  // subfolders like "before/" or "after/" that the walker handles.
  if (IMG_EXTS.has(ext)) {
    if (lower.includes('before') || lower.includes('start')) return 'before_photo';
    if (lower.includes('after') || lower.includes('final') || lower.includes('done')) return 'after_photo';
    return 'scope_photo';
  }
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (SHEET_EXTS.has(ext)) return 'spreadsheet';
  if (ext === '.md') return 'notes_md';

  return 'other';
}

// ─── J-ID extraction ─────────────────────────────────────────────────────────
// Brad's invoice filenames embed the job ID. Variants seen in the audit:
//   INV-J12.pdf, INV-J12-F.pdf, INV-J12-Deposit.pdf
//   INV-027-J13-Deposit.pdf, INV-Q032-final.pdf (the latter is QUOTE-ID based,
//   not job-id; we don't extract a J-ID from those)
//
// Returns the first J-ID we find or null. Case-insensitive match.

function extractJobIdFromFilename(name: string): string | null {
  const m = /\bJ(\d+)\b/i.exec(name);
  if (!m) return null;
  return `J${m[1]}`;
}

function findJobIdInFolder(folderPath: string): { jobId: string | null; sourceFile: string | null } {
  const files = listFilesShallow(folderPath);
  for (const f of files) {
    const id = extractJobIdFromFilename(f);
    if (id) return { jobId: id, sourceFile: f };
  }
  // Also scan one level deep — some jobs have nested subfolders with
  // their invoices in them.
  for (const f of files) {
    const sub = join(folderPath, f);
    try {
      if (statSync(sub).isDirectory()) {
        for (const inner of listFilesShallow(sub)) {
          const id = extractJobIdFromFilename(inner);
          if (id) return { jobId: id, sourceFile: `${f}/${inner}` };
        }
      }
    } catch { /* unreadable subfolder — skip */ }
  }
  return { jobId: null, sourceFile: null };
}

function listFilesShallow(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ─── Folder-name tokenisation for fuzzy match ────────────────────────────────
// Reuses the same approach as lib/job-match.ts: lowercase, strip punctuation,
// split on whitespace, keep tokens >= 3 chars. Lower-cased so "McLeod" and
// "mcleod" match. Trailing-space-in-folder-names is stripped by tokeniser.

function tokenise(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

// ─── Job lookup ─────────────────────────────────────────────────────────────
type JobRow = {
  id: string;
  legacy_id: string | null;
  name: string | null;
  client_name: string | null;
  location: string | null;
};

async function loadJobs(): Promise<JobRow[]> {
  const { data, error } = await sb.from('jobs').select('id, legacy_id, name, client_name, location');
  if (error) {
    console.error('Failed to load jobs:', error);
    process.exit(1);
  }
  return (data ?? []) as JobRow[];
}

function findJobByLegacyId(jobs: JobRow[], legacyId: string): JobRow | undefined {
  const target = legacyId.toLowerCase();
  return jobs.find((j) => (j.legacy_id ?? '').toLowerCase() === target);
}

function fuzzyJobMatch(jobs: JobRow[], folderName: string): { job: JobRow; score: number } | null {
  const folderTokens = new Set(tokenise(folderName));
  if (folderTokens.size === 0) return null;
  let best: { job: JobRow; score: number } | null = null;
  for (const j of jobs) {
    const jobBlob = [j.name, j.client_name, j.location, j.legacy_id].filter(Boolean).join(' ');
    const jobTokens = new Set(tokenise(jobBlob));
    let score = 0;
    for (const t of folderTokens) {
      if (jobTokens.has(t)) score += 10;
      else {
        for (const jt of jobTokens) {
          if (jt.includes(t) || t.includes(jt)) { score += 4; break; }
        }
      }
    }
    if (score > 0 && (best === null || score > best.score)) best = { job: j, score };
  }
  return best;
}

// ─── Folder walker ──────────────────────────────────────────────────────────

interface FolderSummary {
  folder: string;             // basename, e.g. "10 McLeod Ave"
  folderPath: string;         // absolute path
  fileCounts: Record<FileKind, number>;
  totalFiles: number;
  matchedJob: JobRow | null;
  matchSource: 'jid' | 'fuzzy' | 'none';
  matchSourceFile?: string;   // for jid matches, the file that revealed it
  matchScore?: number;        // for fuzzy matches
  matchConfidence: 'high' | 'medium' | 'low' | 'none';
  notes: string[];
}

function emptyKindCounts(): Record<FileKind, number> {
  return {
    plan: 0, quote_pdf: 0, invoice_pdf: 0,
    before_photo: 0, after_photo: 0, scope_photo: 0,
    notes_md: 0, video: 0, spreadsheet: 0, other: 0,
  };
}

function walkFolder(folderPath: string, jobs: JobRow[]): FolderSummary {
  const folder = basename(folderPath).trim() || basename(folderPath);
  const summary: FolderSummary = {
    folder,
    folderPath,
    fileCounts: emptyKindCounts(),
    totalFiles: 0,
    matchedJob: null,
    matchSource: 'none',
    matchConfidence: 'none',
    notes: [],
  };

  // Recurse one level deep to count file kinds. Deeper nesting is rare
  // and treated as "other" lump per the audit (heic-previews etc).
  function classifyAll(dir: string, depth: number) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < 3) classifyAll(p, depth + 1);
      } else {
        const kind = classifyFile(name);
        summary.fileCounts[kind] += 1;
        summary.totalFiles += 1;
      }
    }
  }
  classifyAll(folderPath, 0);

  // Match via J-ID first
  const { jobId, sourceFile } = findJobIdInFolder(folderPath);
  if (jobId) {
    const match = findJobByLegacyId(jobs, jobId);
    if (match) {
      summary.matchedJob = match;
      summary.matchSource = 'jid';
      summary.matchSourceFile = sourceFile ?? undefined;
      summary.matchConfidence = 'high';
      return summary;
    }
    summary.notes.push(`Found J-ID ${jobId} in ${sourceFile} but no matching jobs row.`);
  }

  // Fall back to fuzzy match
  const fuzzy = fuzzyJobMatch(jobs, folder);
  if (fuzzy) {
    summary.matchedJob = fuzzy.job;
    summary.matchSource = 'fuzzy';
    summary.matchScore = fuzzy.score;
    // Score >= 20 = strong overlap (2+ tokens hit), 10-19 = single token,
    // <10 = soft substring only.
    summary.matchConfidence = fuzzy.score >= 20 ? 'medium' : 'low';
  }

  return summary;
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printReport(summaries: FolderSummary[]) {
  const byConf: Record<string, FolderSummary[]> = { high: [], medium: [], low: [], none: [] };
  for (const s of summaries) byConf[s.matchConfidence].push(s);

  console.log(`\n📁  Walked ${summaries.length} folders in ${PROJECTS_DIR}\n`);
  console.log('Confidence summary:');
  console.log(`  high   (J-ID matches)        : ${byConf.high.length}`);
  console.log(`  medium (strong fuzzy)        : ${byConf.medium.length}`);
  console.log(`  low    (weak fuzzy)          : ${byConf.low.length}`);
  console.log(`  none   (no match at all)     : ${byConf.none.length}`);
  console.log();

  for (const conf of ['high', 'medium', 'low', 'none'] as const) {
    const rows = byConf[conf];
    if (rows.length === 0) continue;
    console.log(`── ${conf.toUpperCase()} CONFIDENCE (${rows.length}) ─────────────────────────────────`);
    for (const r of rows) {
      const jobLabel = r.matchedJob
        ? `${r.matchedJob.legacy_id ?? '(no J-id)'}  ${r.matchedJob.name ?? '(no name)'}  ·  ${r.matchedJob.client_name ?? ''}`
        : '(no match)';
      const matchInfo = r.matchSource === 'jid'
        ? `J-ID via ${r.matchSourceFile}`
        : r.matchSource === 'fuzzy'
          ? `fuzzy score ${r.matchScore}`
          : '—';
      console.log(`  ${r.folder.padEnd(34)}  →  ${jobLabel}`);
      console.log(`      match: ${matchInfo}`);
      const counts = r.fileCounts;
      const interesting: string[] = [];
      if (counts.plan) interesting.push(`${counts.plan} plan`);
      if (counts.quote_pdf) interesting.push(`${counts.quote_pdf} quote`);
      if (counts.invoice_pdf) interesting.push(`${counts.invoice_pdf} invoice`);
      const photos = counts.before_photo + counts.after_photo + counts.scope_photo;
      if (photos) interesting.push(`${photos} photo${photos === 1 ? '' : 's'}`);
      if (counts.video) interesting.push(`${counts.video} video${counts.video === 1 ? '' : 's'}`);
      if (counts.notes_md) interesting.push(`${counts.notes_md} note`);
      if (interesting.length) console.log(`      files: ${interesting.join(' · ')}  (${r.totalFiles} total)`);
      else console.log(`      files: ${r.totalFiles} total (no key kinds detected)`);
      for (const n of r.notes) console.log(`      ⚠ ${n}`);
    }
    console.log();
  }

  if (APPLY) {
    console.log('🚧  --apply not yet implemented in this commit. The next commit wires up:');
    console.log('    1. quote_pdf parsing via Anthropic (same pattern as bill parser)');
    console.log('    2. plan + photo uploads to the quote-attachments Storage bucket');
    console.log('    3. inserts/updates into quotes + quote_attachments tables');
    console.log('    Re-run without --apply for now to inspect proposed actions.');
  } else {
    console.log('💡  Dry run complete. Mapping CSV written — see below.');
  }
}

/**
 * Build a one-row-per-folder summary of what the importer would do, save
 * it to scripts/import-projects-mapping.csv for Brad to open in Numbers
 * and edit. Each row defaults to a `decision` he can adjust:
 *   - "link"   = use the suggested job (default for HIGH-confidence rows)
 *   - "review" = needs eyeballs (default for MEDIUM/LOW)
 *   - "skip"   = don't import this folder
 *   - "create" = create a new job from this folder
 * He can also overwrite `suggested_job_id` if our match was wrong.
 *
 * The --apply step (next commit) reads this CSV instead of re-running
 * fuzzy matching, so his decisions are the source of truth.
 */
function writeMappingCsv(summaries: FolderSummary[], outPath: string) {
  // Header columns chosen to match what's actionable in a spreadsheet.
  // Keep them short so the file is browsable; the report on stdout shows
  // the full file-kind breakdown.
  const headers = [
    'folder',
    'suggested_job_id',
    'suggested_legacy_id',
    'suggested_job_label',
    'confidence',
    'match_source',
    'decision',
    'files_summary',
    'notes',
  ];

  // Default the decision based on confidence so the easy wins are
  // pre-approved and Brad only has to touch the rows that need it.
  function defaultDecision(s: FolderSummary): string {
    if (s.matchConfidence === 'high') return 'link';
    return 'review';
  }

  function filesSummary(s: FolderSummary): string {
    const c = s.fileCounts;
    const parts: string[] = [];
    if (c.plan) parts.push(`${c.plan}plan`);
    if (c.quote_pdf) parts.push(`${c.quote_pdf}quote`);
    if (c.invoice_pdf) parts.push(`${c.invoice_pdf}inv`);
    const photos = c.before_photo + c.after_photo + c.scope_photo;
    if (photos) parts.push(`${photos}photo`);
    if (c.video) parts.push(`${c.video}vid`);
    if (c.notes_md) parts.push(`${c.notes_md}note`);
    return parts.join('+') || `${s.totalFiles}files`;
  }

  function csvEscape(v: string | number | null | undefined): string {
    const s = v == null ? '' : String(v);
    // RFC4180-style: wrap in double quotes if it contains comma/quote/newline.
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  const rows: string[] = [];
  rows.push(headers.join(','));
  for (const s of summaries) {
    rows.push([
      csvEscape(s.folder),
      csvEscape(s.matchedJob?.id ?? ''),
      csvEscape(s.matchedJob?.legacy_id ?? ''),
      csvEscape(s.matchedJob ? `${s.matchedJob.name ?? ''} · ${s.matchedJob.client_name ?? ''}` : ''),
      csvEscape(s.matchConfidence),
      csvEscape(s.matchSource === 'jid'
        ? `J-ID via ${s.matchSourceFile ?? ''}`
        : s.matchSource === 'fuzzy'
          ? `fuzzy ${s.matchScore}`
          : ''),
      csvEscape(defaultDecision(s)),
      csvEscape(filesSummary(s)),
      csvEscape(s.notes.join(' | ')),
    ].join(','));
  }

  writeFileSync(outPath, rows.join('\n') + '\n', 'utf-8');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Loading jobs from Supabase…`);
  const jobs = await loadJobs();
  console.log(`  → ${jobs.length} jobs found.`);

  let entries: string[];
  try {
    entries = readdirSync(PROJECTS_DIR);
  } catch (err) {
    console.error(`Couldn't read ${PROJECTS_DIR}:`, err);
    process.exit(1);
  }

  const summaries: FolderSummary[] = [];
  for (const name of entries) {
    const full = join(PROJECTS_DIR, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch { continue; }
    summaries.push(walkFolder(full, jobs));
  }

  printReport(summaries);

  // Write the mapping CSV alongside the script — useful as a reference
  // when reviewing on Home, even though the in-app review is now the
  // primary interface. Same file as before; previous decisions you've
  // hand-edited get overwritten on rerun.
  const mappingPath = join(HERE, 'import-projects-mapping.csv');
  writeMappingCsv(summaries, mappingPath);
  console.log(`\n📝  Mapping CSV written to:\n    ${mappingPath}\n`);

  if (!APPLY) {
    console.log('💡  Dry run complete. Re-run with --apply to stage these into job_imports.');
    return;
  }

  // ── APPLY: stage each folder into job_imports + upload attachments ───
  console.log('\n🚀  --apply mode: writing job_imports rows + uploading attachments…');
  if (LIMIT < summaries.length) {
    console.log(`   (--limit=${LIMIT}; only the first ${LIMIT} folders will be processed)`);
  }
  let processed = 0;
  let staged = 0;
  let updated = 0;
  let attachmentsUploaded = 0;
  let parsesAttempted = 0;
  let parsesSucceeded = 0;
  for (const summary of summaries) {
    if (processed >= LIMIT) break;
    processed++;
    const result = await applyOne(summary);
    if (result.action === 'inserted') staged++;
    else if (result.action === 'updated') updated++;
    attachmentsUploaded += result.attachmentsUploaded;
    if (result.parseAttempted) parsesAttempted++;
    if (result.parseSucceeded) parsesSucceeded++;
  }
  console.log(`\n✅  --apply complete:`);
  console.log(`   ${staged} new + ${updated} updated job_imports rows`);
  console.log(`   ${attachmentsUploaded} files uploaded to Storage`);
  console.log(`   ${parsesSucceeded}/${parsesAttempted} quote PDFs parsed`);
  console.log(`\n   Open the app's Home page — the "Imports to review" flag should now`);
  console.log(`   show ${staged + updated} drafts waiting for your decision.`);
}

// ── apply: per-folder commit logic ──────────────────────────────────────────

interface ApplyResult {
  action: 'inserted' | 'updated' | 'skipped-existing-committed' | 'error';
  attachmentsUploaded: number;
  parseAttempted: boolean;
  parseSucceeded: boolean;
  error?: string;
}

async function applyOne(summary: FolderSummary): Promise<ApplyResult> {
  // Check whether this folder already has a job_imports row (idempotency).
  const { data: existing, error: lookupErr } = await sb
    .from('job_imports')
    .select('id, status, attachments_storage_prefix')
    .eq('business_id', BUSINESS_ID)
    .eq('source_path', summary.folderPath)
    .maybeSingle();
  if (lookupErr) {
    console.warn(`  ✗ ${summary.folder}: lookup failed —`, lookupErr.message);
    return { action: 'error', attachmentsUploaded: 0, parseAttempted: false, parseSucceeded: false, error: lookupErr.message };
  }

  // If a row exists AND it's already been committed/skipped by the user,
  // don't blow it away on a re-run. Idempotency without overwriting human
  // decisions.
  if (existing && existing.status !== 'pending') {
    console.log(`  ⏭  ${summary.folder}: already ${existing.status}, leaving alone.`);
    return { action: 'skipped-existing-committed', attachmentsUploaded: 0, parseAttempted: false, parseSucceeded: false };
  }

  // Determine the storage prefix. New imports get a fresh UUID; existing
  // pending rows reuse their prefix (so re-running --apply doesn't leave
  // orphan storage objects from the previous run).
  const importId = existing?.id ?? randomUUID();
  const storagePrefix = existing?.attachments_storage_prefix
    ?? `_pending/${importId}`;

  // ── 1. Upload selected attachments ────────────────────────────────────
  // Plans: upload all. Photos: pick the first MAX_PHOTOS_PER_IMPORT
  // (deterministic — sort by name so re-runs hit the same files).
  // Quote PDF: upload (for inline preview), AND parse below.
  const filesToUpload: { localPath: string; storageKey: string; kind: string }[] = [];

  const allFiles = listAllFilesUpToDepth(summary.folderPath, 3);
  const plans = allFiles.filter((f) => classifyFile(basename(f)) === 'plan');
  const photos = allFiles
    .filter((f) => {
      const k = classifyFile(basename(f));
      return k === 'before_photo' || k === 'after_photo' || k === 'scope_photo';
    })
    .sort()
    .slice(0, MAX_PHOTOS_PER_IMPORT);
  const quotePdfs = allFiles.filter((f) => classifyFile(basename(f)) === 'quote_pdf');

  for (const p of [...plans, ...photos, ...quotePdfs]) {
    const name = basename(p);
    const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const storageKey = `${BUSINESS_ID}/${storagePrefix}/${randomUUID()}__${safeName}`;
    filesToUpload.push({ localPath: p, storageKey, kind: classifyFile(name) });
  }

  let uploaded = 0;
  for (const f of filesToUpload) {
    try {
      const st = statSync(f.localPath);
      if (st.size > MAX_FILE_BYTES) continue;
      const bytes = readFileSync(f.localPath);
      const contentType = guessContentType(f.localPath);
      const { error: upErr } = await sb.storage
        .from('quote-attachments')
        .upload(f.storageKey, bytes, {
          contentType,
          upsert: true,
        });
      if (upErr) {
        console.warn(`    ⚠ upload failed: ${basename(f.localPath)} —`, upErr.message);
        continue;
      }
      uploaded++;
    } catch (err) {
      console.warn(`    ⚠ read/upload error: ${basename(f.localPath)} —`, err);
    }
  }

  // ── 2. Parse any quote PDF via Anthropic ───────────────────────────────
  let parsed: ParsedQuote | null = null;
  let parseAttempted = false;
  let parseSucceeded = false;
  if (quotePdfs.length > 0) {
    parseAttempted = true;
    // Use only the first quote PDF for parsing — multiples on the same
    // job are rare and re-parsing them is wasteful API spend.
    const text = await extractPdfText(quotePdfs[0]).catch(() => null);
    if (text && text.length > 20) {
      try {
        parsed = await parseQuoteText(text);
        parseSucceeded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`    ⚠ parse failed: ${basename(quotePdfs[0])} — ${msg}`);
      }
    }
  }

  // ── 3. Upsert the job_imports row ──────────────────────────────────────
  const rowData: Record<string, unknown> = {
    business_id: BUSINESS_ID,
    source_path: summary.folderPath,
    folder_name: summary.folder,
    suggested_job_id: summary.matchedJob?.id ?? null,
    suggested_legacy_id: summary.matchedJob?.legacy_id ?? null,
    suggested_label: summary.matchedJob
      ? `${summary.matchedJob.name ?? ''} · ${summary.matchedJob.client_name ?? ''}`
      : null,
    match_confidence: summary.matchConfidence,
    match_source: summary.matchSource === 'jid'
      ? `J-ID via ${summary.matchSourceFile ?? ''}`
      : summary.matchSource === 'fuzzy'
        ? `fuzzy ${summary.matchScore}`
        : null,
    files_summary: trimFolderCountsForJson(summary.fileCounts),
    attachments_storage_prefix: storagePrefix,
    parsed_data: parsed,
    status: 'pending',
    notes: summary.notes.join(' | ') || null,
  };

  if (existing) {
    const { error: upErr } = await sb
      .from('job_imports')
      .update(rowData)
      .eq('id', existing.id);
    if (upErr) {
      console.warn(`  ✗ ${summary.folder}: update failed —`, upErr.message);
      return { action: 'error', attachmentsUploaded: uploaded, parseAttempted, parseSucceeded, error: upErr.message };
    }
    console.log(`  ⟳ ${summary.folder}: updated (${uploaded} files, parse: ${parseSucceeded ? 'ok' : 'no'})`);
    return { action: 'updated', attachmentsUploaded: uploaded, parseAttempted, parseSucceeded };
  } else {
    rowData.id = importId;
    const { error: insErr } = await sb.from('job_imports').insert(rowData);
    if (insErr) {
      console.warn(`  ✗ ${summary.folder}: insert failed —`, insErr.message);
      return { action: 'error', attachmentsUploaded: uploaded, parseAttempted, parseSucceeded, error: insErr.message };
    }
    console.log(`  + ${summary.folder}: staged (${uploaded} files, parse: ${parseSucceeded ? 'ok' : 'no'})`);
    return { action: 'inserted', attachmentsUploaded: uploaded, parseAttempted, parseSucceeded };
  }
}

// ── Helpers used by apply ───────────────────────────────────────────────────

function listAllFilesUpToDepth(dir: string, maxDepth: number): string[] {
  const out: string[] = [];
  function walk(d: string, depth: number) {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
      } else {
        out.push(p);
      }
    }
  }
  walk(dir, 0);
  return out;
}

/** unpdf-based text extraction. Reads PDF buffer, returns plain text. */
async function extractPdfText(path: string): Promise<string> {
  const buffer = readFileSync(path);
  const data = new Uint8Array(buffer);
  const doc = await getDocumentProxy(data);
  const { text: pagesText } = await extractText(doc, { mergePages: false });
  const joined = Array.isArray(pagesText) ? pagesText.join('\n\n') : String(pagesText);
  return joined.trim();
}

function guessContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}

/** Strip out zero counts so the jsonb blob is smaller / cleaner to read. */
function trimFolderCountsForJson(counts: Record<FileKind, number>): FolderFileCounts {
  const out: FolderFileCounts = {};
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) (out as Record<string, number>)[k] = v;
  }
  return out;
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
