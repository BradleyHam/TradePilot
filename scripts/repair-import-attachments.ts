/**
 * repair-import-attachments.ts
 *
 * One-off repair pass for the 18 (or so) project imports that were
 * committed via Home before the quote_attachments INSERT bug was fixed.
 *
 * What went wrong:
 *   migration 007 created the quote_attachments RLS policy with
 *   `for all using (...)` but NO `with check (...)` clause. PostgREST
 *   silently rejects browser-client INSERTs in that shape, so every
 *   Link / Create commit succeeded for the quote row but left
 *   quote_attachments empty. Migration 009 adds the missing WITH CHECK.
 *
 * What this script does:
 *   Uses the SERVICE ROLE key (bypasses RLS entirely, so works whether
 *   or not migration 009 has been applied yet), walks every job_imports
 *   row with status=committed + commit_action in (link, create) +
 *   commit_target_quote_id set, then:
 *
 *     1. Lists the staged files at `{businessId}/_pending/{importId}/`
 *     2. For each file, classifies it the same way lib/store.tsx does
 *     3. Moves PLANS to `{businessId}/{quoteId}/{uuid}__{name}` and
 *        inserts the matching quote_attachments row
 *     4. Removes non-plan files from _pending/ (per the plans-only
 *        scope decision — photos aren't being attached at this stage)
 *
 *   Idempotent: re-running won't duplicate attachments. If a quote
 *   already has plan attachments, the row is reported and left alone
 *   (its _pending/ leftovers, if any, are still cleaned up).
 *
 * Usage:
 *   npx tsx scripts/repair-import-attachments.ts
 *     dry run — prints what would happen, makes no changes
 *
 *   npx tsx scripts/repair-import-attachments.ts --apply
 *     actually move files + insert rows + delete leftovers
 *
 *   npx tsx scripts/repair-import-attachments.ts --apply --limit=N
 *     only process the first N committed imports (useful for testing)
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, '..', '.env.local') });

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;

// ─── Supabase admin client ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Classification — mirrors lib/store.tsx inferAttachmentKind ─────────────
// Kept inline so this script has zero dependencies on store.tsx (which is
// 'use client'-tagged and pulls in React). If the canonical classifier
// changes there, update this too.

type AttachmentKind = 'plan' | 'before_photo' | 'after_photo' | 'scope_photo' | 'quote_pdf' | 'other';

function inferAttachmentKind(name: string): AttachmentKind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) {
    if (lower.includes('plan') || lower.includes('consent') || lower.includes('drawing')) return 'plan';
    if (lower.startsWith('inv-') || lower.includes('invoice')) return 'other';
    if (lower.startsWith('q-') || lower.includes('quote')) return 'quote_pdf';
    return 'other';
  }
  if (/\.(jpe?g|png|webp|heic)$/.test(lower)) {
    if (lower.includes('before') || lower.includes('start')) return 'before_photo';
    if (lower.includes('after') || lower.includes('final') || lower.includes('done')) return 'after_photo';
    return 'scope_photo';
  }
  return 'other';
}

// ─── Types we read from Postgres ────────────────────────────────────────────
interface JobImportRow {
  id: string;
  business_id: string;
  folder_name: string;
  status: string;
  commit_action: string | null;
  commit_target_quote_id: string | null;
  commit_target_job_id: string | null;
  attachments_storage_prefix: string | null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface RepairCounts {
  importsScanned: number;
  importsSkippedNoPrefix: number;
  importsSkippedNoFiles: number;
  importsSkippedAlreadyHasAttachments: number;
  importsRepaired: number;
  plansMoved: number;
  plansInserted: number;
  nonPlansRemoved: number;
  errors: number;
}

async function main() {
  console.log(`\n🔧 Repair import attachments — ${APPLY ? 'APPLY' : 'DRY RUN'} mode\n`);

  // Pull every committed link/create import row that has a quote target.
  // We don't filter by attachments_storage_prefix here because we want to
  // surface (and report) rows whose prefix is missing too — those are
  // worth knowing about even though we can't repair them.
  const { data: imports, error } = await sb
    .from('job_imports')
    .select(
      'id, business_id, folder_name, status, commit_action, commit_target_quote_id, commit_target_job_id, attachments_storage_prefix',
    )
    .eq('status', 'committed')
    .in('commit_action', ['link', 'create'])
    .order('committed_at', { ascending: true });

  if (error) {
    console.error('Failed to load job_imports:', error.message);
    process.exit(1);
  }
  const rows = (imports ?? []) as JobImportRow[];
  console.log(`Found ${rows.length} committed link/create imports.\n`);

  const counts: RepairCounts = {
    importsScanned: 0,
    importsSkippedNoPrefix: 0,
    importsSkippedNoFiles: 0,
    importsSkippedAlreadyHasAttachments: 0,
    importsRepaired: 0,
    plansMoved: 0,
    plansInserted: 0,
    nonPlansRemoved: 0,
    errors: 0,
  };

  for (const imp of rows) {
    if (counts.importsScanned >= LIMIT) {
      console.log(`(limit=${LIMIT} reached, stopping)`);
      break;
    }
    counts.importsScanned++;

    const label = `[${imp.folder_name}]`;

    if (!imp.commit_target_quote_id) {
      console.log(`${label} ⚠ no commit_target_quote_id — skipping (committed without a quote row?)`);
      counts.errors++;
      continue;
    }
    if (!imp.attachments_storage_prefix) {
      console.log(`${label} ⏭  no attachments_storage_prefix — nothing was staged for this folder`);
      counts.importsSkippedNoPrefix++;
      continue;
    }

    await repairOne(imp, counts, label);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n─── Summary ──────────────────────────────────────────────────`);
  console.log(`Imports scanned                   : ${counts.importsScanned}`);
  console.log(`  → already had attachments       : ${counts.importsSkippedAlreadyHasAttachments}`);
  console.log(`  → no storage prefix recorded    : ${counts.importsSkippedNoPrefix}`);
  console.log(`  → prefix existed but was empty  : ${counts.importsSkippedNoFiles}`);
  console.log(`  → repaired (had plans to move)  : ${counts.importsRepaired}`);
  console.log(`Plans moved                       : ${counts.plansMoved}`);
  console.log(`Plans inserted into quote_attach. : ${counts.plansInserted}`);
  console.log(`Non-plan files removed            : ${counts.nonPlansRemoved}`);
  console.log(`Errors                            : ${counts.errors}`);
  if (!APPLY) {
    console.log(`\n💡 Dry run complete. Re-run with --apply to perform the moves + inserts.`);
  } else {
    console.log(`\n✅ Repair complete.`);
  }
}

// ─── Per-import repair ──────────────────────────────────────────────────────

async function repairOne(imp: JobImportRow, counts: RepairCounts, label: string): Promise<void> {
  const businessId = imp.business_id;
  const quoteId = imp.commit_target_quote_id!;
  const stagedDir = `${businessId}/${imp.attachments_storage_prefix}`;

  // 0. Has this quote already been (partially) repaired? If it has any
  //    plan attachments, leave the quote_attachments table alone — we
  //    don't want to duplicate. We DO still clean up any non-plan files
  //    that might be sitting in _pending/.
  const { data: existingAttachments, error: existingErr } = await sb
    .from('quote_attachments')
    .select('id, kind')
    .eq('quote_id', quoteId);
  if (existingErr) {
    console.log(`${label} ✗ couldn't check existing attachments: ${existingErr.message}`);
    counts.errors++;
    return;
  }
  const alreadyHasPlans = (existingAttachments ?? []).some((a) => a.kind === 'plan');

  // 1. List staged files
  const { data: stagedFiles, error: listErr } = await sb.storage
    .from('quote-attachments')
    .list(stagedDir, { limit: 100 });
  if (listErr) {
    console.log(`${label} ✗ couldn't list ${stagedDir}: ${listErr.message}`);
    counts.errors++;
    return;
  }
  if (!stagedFiles || stagedFiles.length === 0) {
    console.log(`${label} ⏭  ${stagedDir} is empty — nothing to repair`);
    counts.importsSkippedNoFiles++;
    return;
  }

  // 2. Classify
  const plans: { name: string; fromPath: string; cleanName: string }[] = [];
  const toRemove: string[] = [];
  for (const f of stagedFiles) {
    const fromPath = `${stagedDir}/${f.name}`;
    const sepIdx = f.name.indexOf('__');
    const cleanName = sepIdx >= 0 ? f.name.slice(sepIdx + 2) : f.name;
    const kind = inferAttachmentKind(cleanName);
    if (kind === 'plan') {
      plans.push({ name: f.name, fromPath, cleanName });
    } else {
      toRemove.push(fromPath);
    }
  }

  console.log(
    `${label} ${plans.length} plan${plans.length === 1 ? '' : 's'}, ` +
    `${toRemove.length} non-plan to remove` +
    `${alreadyHasPlans ? ' · already has plan attachments — skipping inserts' : ''}`,
  );

  // 3. Move + insert plans (skipped if already repaired)
  if (!alreadyHasPlans && plans.length > 0) {
    for (const p of plans) {
      const toPath = `${businessId}/${quoteId}/${randomUUID()}__${p.cleanName}`;
      if (!APPLY) {
        console.log(`  · would move: ${p.fromPath} → ${toPath}`);
        console.log(`  · would insert: quote_attachments(quote_id=${quoteId}, kind=plan, file_name=${p.cleanName})`);
        continue;
      }

      const { error: mvErr } = await sb.storage
        .from('quote-attachments')
        .move(p.fromPath, toPath);
      if (mvErr) {
        console.log(`  ✗ move failed for ${p.cleanName}: ${mvErr.message}`);
        counts.errors++;
        continue;
      }
      counts.plansMoved++;

      const { error: insErr } = await sb.from('quote_attachments').insert({
        business_id: businessId,
        quote_id: quoteId,
        kind: 'plan',
        storage_path: toPath,
        file_name: p.cleanName,
      });
      if (insErr) {
        console.log(`  ✗ insert failed for ${p.cleanName}: ${insErr.message}`);
        counts.errors++;
        continue;
      }
      counts.plansInserted++;
      console.log(`  ✓ ${p.cleanName}`);
    }
  } else if (alreadyHasPlans && plans.length > 0) {
    // If there are plans in _pending/ AND quote_attachments already has
    // plan rows, the safe thing is to leave the _pending/ ones alone
    // rather than risk attaching duplicates or deleting the only copy.
    // Brad can sweep them manually if needed.
    console.log(`  · ${plans.length} plan(s) in _pending/ left in place (quote already has plan attachments)`);
  }

  // 4. Sweep non-plan files (always — they're not being kept regardless
  //    of attachment state, per the plans-only scope decision).
  if (toRemove.length > 0) {
    if (!APPLY) {
      console.log(`  · would delete ${toRemove.length} non-plan file(s) from _pending/`);
    } else {
      const { error: rmErr } = await sb.storage
        .from('quote-attachments')
        .remove(toRemove);
      if (rmErr) {
        console.log(`  ✗ cleanup of non-plan files failed: ${rmErr.message}`);
        counts.errors++;
      } else {
        counts.nonPlansRemoved += toRemove.length;
        console.log(`  ✓ removed ${toRemove.length} non-plan file(s)`);
      }
    }
  }

  if (alreadyHasPlans) {
    counts.importsSkippedAlreadyHasAttachments++;
  } else if (plans.length > 0) {
    counts.importsRepaired++;
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
