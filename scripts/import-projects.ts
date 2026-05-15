/**
 * import-projects.ts
 *
 * Walks /Users/bradleyhamilton/Desktop/lakeside-painting/projects (or a
 * configurable path), identifies each per-job folder, matches it to an
 * existing `jobs` row, classifies the files inside, and either prints a
 * dry-run report (default) or actually creates/updates `quotes` rows +
 * uploads attachments (--apply).
 *
 * This first commit implements DRY RUN ONLY — no writes, no uploads. The
 * --apply path is wired up structurally (with TODO logging) so we can
 * verify the match logic against Brad's eyes before any data lands.
 *
 *   npx tsx scripts/import-projects.ts
 *     dry run, prints the proposed action per folder
 *
 *   npx tsx scripts/import-projects.ts --projects-dir=/path/to/projects
 *     override the input folder if not at the default
 *
 *   npx tsx scripts/import-projects.ts --apply
 *     (not yet implemented — currently aborts with a TODO message)
 *
 * Match strategy per folder, in order:
 *   1. Scan invoice filenames for a J-ID pattern (e.g. INV-J12-*.pdf
 *      OR INV-027-J13-*.pdf). High-confidence hit.
 *   2. If no J-ID found, fuzzy-match folder name against
 *      jobs.name + jobs.location + jobs.client_name. Score >= threshold
 *      = medium confidence; below = low/no match.
 *   3. Anything ambiguous is reported and skipped (no writes in --apply).
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') });

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const projectsDirArg = args.find((a) => a.startsWith('--projects-dir='));
const DEFAULT_PROJECTS_DIR = '/Users/bradleyhamilton/Desktop/lakeside-painting/projects';
const PROJECTS_DIR = projectsDirArg
  ? projectsDirArg.slice('--projects-dir='.length)
  : DEFAULT_PROJECTS_DIR;

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
    console.log('💡  Dry run complete. Re-run with --apply once writes are implemented.');
  }
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
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
