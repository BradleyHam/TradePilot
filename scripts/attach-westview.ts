/**
 * attach-westview.ts — one-off script.
 *
 * Uploads the 23 Westview Rd folder contents into the existing draft
 * quote on the (lost) 23 Westview Rd job:
 *   - 12 optimised scope photos  → kind = 'scope_photo'
 *   - Compressed Plans.pdf       → kind = 'plan'
 *   - QUO-036 quote PDF          → kind = 'quote_pdf'
 *
 * Idempotent: skips files already present (by fileName + kind on the
 * same quote_id). Safe to re-run.
 *
 * Run:
 *   cd TradePilot-lakeside
 *   npx tsx scripts/attach-westview.ts            # dry-run
 *   npx tsx scripts/attach-westview.ts --apply    # actually upload + insert
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, '..', '.env.local') });

const APPLY = process.argv.includes('--apply');

// ─── Locations of the optimised files ──────────────────────────────────────
// Photos optimised earlier into the source folder's `optimised/` subdir.
// Plans-v2.pdf is the JPEG-rasterised compressed version (8.6 MB, down
// from 21 MB original).
const SOURCE_DIR = '/Users/bradleyhamilton/Desktop/lakeside-painting/projects/23 Westview rd ';
const PHOTOS_DIR = `${SOURCE_DIR}/optimised`;
const OPTIMISED_PLANS = '/Users/bradleyhamilton/Library/Application Support/Claude/local-agent-mode-sessions/57186099-2bf3-410d-9045-75b04dead8a4/f67f9f24-572d-4372-b812-b26726760520/local_73b134c5-1e54-4f97-ada5-4fdf55047dd0/outputs/westview/Plans-v2.pdf';
const QUOTE_PDF = `${SOURCE_DIR}/QUO-036 - Soderstrom - 23 Westview Rd Cedar Restain.pdf`;

const PHOTO_FILES = [
  'IMG_6567.jpeg','IMG_6568.jpeg','IMG_6569.jpeg','IMG_6570.jpeg',
  'IMG_6571.jpeg','IMG_6572.jpeg','IMG_6573.jpeg','IMG_6574.jpeg',
  'IMG_6575.jpeg','IMG_6577.jpeg','IMG_6578.jpeg','IMG_6580.jpeg',
];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUSINESS_ID = process.env.TRADEPILOT_BUSINESS_ID!;
if (!SUPABASE_URL || !SERVICE_KEY || !BUSINESS_ID) {
  console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TRADEPILOT_BUSINESS_ID');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function contentTypeFor(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

async function main() {
  console.log(APPLY ? '🚀  --apply mode' : '🔍  dry-run (no writes)');

  // ── 1. Find the 23 Westview Rd job ────────────────────────────────────
  const { data: jobs, error: jobErr } = await sb
    .from('jobs')
    .select('id, name, location, status')
    .eq('business_id', BUSINESS_ID)
    .or('name.ilike.%westview%,location.ilike.%westview%');
  if (jobErr) { console.error('job lookup failed:', jobErr); process.exit(1); }
  if (!jobs || jobs.length === 0) {
    console.error('No job found matching "westview". Aborting.'); process.exit(1);
  }
  if (jobs.length > 1) {
    console.warn(`Found ${jobs.length} matching jobs:`);
    jobs.forEach((j) => console.warn(`   - ${j.id} | ${j.name} | ${j.location} | ${j.status}`));
    console.warn('Refusing to guess; aborting.'); process.exit(1);
  }
  const job = jobs[0];
  console.log(`✓ Job: ${job.id} | ${job.name} | ${job.status}`);

  // ── 2. Find the draft quote on this job ───────────────────────────────
  const { data: quotes, error: qErr } = await sb
    .from('quotes')
    .select('id, status, total_amount_incl_gst, created_at')
    .eq('business_id', BUSINESS_ID)
    .eq('job_id', job.id)
    .order('created_at', { ascending: true });
  if (qErr) { console.error('quote lookup failed:', qErr); process.exit(1); }
  if (!quotes || quotes.length === 0) {
    console.error('No quote attached to this job. Aborting.'); process.exit(1);
  }
  // Take the first quote (the draft #c9669c4b you can see in the UI).
  const quote = quotes[0];
  console.log(`✓ Quote: ${quote.id} | status=${quote.status}`);

  // ── 3. Build the upload plan ──────────────────────────────────────────
  type Plan = { localPath: string; fileName: string; kind: 'scope_photo' | 'plan' | 'quote_pdf' };
  const plan: Plan[] = [];

  for (const name of PHOTO_FILES) {
    const local = join(PHOTOS_DIR, name);
    if (!existsSync(local)) {
      console.warn(`   ⚠ missing photo: ${name}`); continue;
    }
    plan.push({ localPath: local, fileName: name, kind: 'scope_photo' });
  }
  if (existsSync(OPTIMISED_PLANS)) {
    plan.push({ localPath: OPTIMISED_PLANS, fileName: 'Plans.pdf', kind: 'plan' });
  } else {
    console.warn(`   ⚠ missing optimised plans: ${OPTIMISED_PLANS}`);
  }
  if (existsSync(QUOTE_PDF)) {
    plan.push({ localPath: QUOTE_PDF, fileName: basename(QUOTE_PDF), kind: 'quote_pdf' });
  } else {
    console.warn(`   ⚠ missing quote PDF: ${QUOTE_PDF}`);
  }

  // ── 4. Filter out already-attached files (idempotency) ────────────────
  const { data: existing, error: exErr } = await sb
    .from('quote_attachments')
    .select('file_name, kind')
    .eq('quote_id', quote.id);
  if (exErr) { console.error('existing-attachment lookup failed:', exErr); process.exit(1); }
  const existingKeys = new Set((existing ?? []).map((r) => `${r.kind}::${r.file_name}`));

  const todo = plan.filter((p) => !existingKeys.has(`${p.kind}::${p.fileName}`));
  const skipped = plan.length - todo.length;
  console.log(`\nPlan: ${todo.length} to upload, ${skipped} already present`);
  let totalBytes = 0;
  for (const p of todo) {
    const size = statSync(p.localPath).size;
    totalBytes += size;
    console.log(`   ${p.kind.padEnd(12)} ${p.fileName.padEnd(70)} ${(size/1024).toFixed(0)} KB`);
  }
  console.log(`   ──────  total ${(totalBytes/1024/1024).toFixed(1)} MB`);

  if (!APPLY) {
    console.log('\n(dry run — re-run with --apply to upload)');
    return;
  }

  // ── 5. Upload + insert ────────────────────────────────────────────────
  let uploaded = 0, failed = 0;
  for (const p of todo) {
    const safeName = p.fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const storagePath = `${BUSINESS_ID}/${quote.id}/${randomUUID()}__${safeName}`;
    const bytes = readFileSync(p.localPath);
    const ct = contentTypeFor(p.fileName);

    const { error: upErr } = await sb.storage
      .from('quote-attachments')
      .upload(storagePath, bytes, { contentType: ct, upsert: false });
    if (upErr) {
      console.warn(`   ⚠ upload failed: ${p.fileName} — ${upErr.message}`);
      failed++; continue;
    }

    const { error: insErr } = await sb
      .from('quote_attachments')
      .insert({
        business_id: BUSINESS_ID,
        quote_id: quote.id,
        kind: p.kind,
        storage_path: storagePath,
        file_name: p.fileName,
      });
    if (insErr) {
      console.warn(`   ⚠ insert failed: ${p.fileName} — ${insErr.message}`);
      // Best-effort cleanup of the orphan Storage object.
      await sb.storage.from('quote-attachments').remove([storagePath]).catch(() => {});
      failed++; continue;
    }

    console.log(`   ✓ ${p.fileName}`);
    uploaded++;
  }

  console.log(`\n📊  ${uploaded} uploaded, ${failed} failed, ${skipped} skipped (already present)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
