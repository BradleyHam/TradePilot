// One-off backfill: create the Luke Campbell / Condon Scott "Timber
// Weatherboard Restoration" enquiry (received 8 Jul 2026) as an email lead,
// WITH its photos + plan attached — the same shape the extended
// inbound-email-lead webhook would have produced if it had been live when the
// email arrived.
//
// Why a script and not "just forward the email": the enquiry predates the
// attachment feature, and pulling the original file bytes back out of Gmail
// programmatically isn't available here. So you download the attachments once
// and this script uploads them.
//
// ─────────────────────────────────────────────────────────────────────────
// HOW TO RUN (on your Mac, from the TradePilot repo root):
//
//   1. Open Luke's email in Gmail ("Timber Weatherboard Restoration").
//      Hover the attachments → click the download-all (⤓) button, OR download
//      each of: IMG_2297.JPG, IMG_2306.JPG, 260706 Wakeman - Consultant
//      Issue.pdf.  (You can ignore image001.png — it's his signature logo;
//      the script skips it anyway.)
//
//   2. Put those files in a folder, e.g. ~/Downloads/luke-lead/
//
//   3. Run:
//        npx tsx scripts/backfill-luke-lead.ts ~/Downloads/luke-lead
//
//      (If you omit the path it defaults to ./luke-lead in the repo root.)
//
// Needs in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// TRADEPILOT_BUSINESS_ID.
//
// Safe to re-run: it reuses the existing lead (matched on client_email) and
// its stub quote, and skips any attachment whose filename is already present.
// ─────────────────────────────────────────────────────────────────────────

import { config as dotenvConfig } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

dotenvConfig({ path: '.env.local' });

// ── Lead details, transcribed from Luke's email ─────────────────────────────
const LEAD = {
  name: 'Timber weatherboard restoration — Wānaka',
  clientName: 'Luke Campbell (Condon Scott)',
  clientEmail: 'luke@condonscott.nz',
  clientPhone: '+64 3 443 7919',
  // The email describes a renovation "in Wānaka" but gives no site street
  // address — 37 McDougall St is the Condon Scott office, NOT the job. Leave
  // the site address to be confirmed rather than mis-recording the office.
  location: 'Wānaka (site address TBC)',
  notes: [
    'Email enquiry (forwarded from info@lakesidepainting.co.nz), received 8 Jul 2026.',
    '',
    'Renovation project in Wānaka restoring existing timber weatherboards. Boards show black staining and weathering; some sections previously re-stained grey. Client asked for a recommended restoration approach + ballpark cost. Their own thinking: prep then a darker penetrating stain for a more consistent finish. Plans attached show which exterior walls are being retained.',
    '',
    'Lead contact: Luke Campbell — Architectural Designer, Condon Scott (luke@condonscott.nz, +64 3 443 7919). CC: jordan@condonscott.nz, james@condonscott.nz.',
    'Note: confirm the actual site address — 37 McDougall St is the Condon Scott office, not the job.',
    '',
    'Already replied 8 Jul with a $6,500–$9,500 + GST ballpark, pending a site visit.',
  ].join('\n'),
};

// Filenames to always skip (email signature/logo images).
const SKIP_NAMES = new Set(['image001.png']);

function contentTypeFor(name: string): string {
  const l = name.toLowerCase();
  if (l.endsWith('.pdf')) return 'application/pdf';
  if (l.endsWith('.png')) return 'image/png';
  if (l.endsWith('.jpg') || l.endsWith('.jpeg')) return 'image/jpeg';
  if (l.endsWith('.webp')) return 'image/webp';
  if (l.endsWith('.heic') || l.endsWith('.heif')) return 'image/heic';
  return 'application/octet-stream';
}

// Same inference the webhook uses (lead context): PDF → plan, image → scope.
function inferKind(name: string): string {
  const l = name.toLowerCase();
  if (l.endsWith('.pdf')) {
    if (l.startsWith('q-') || l.includes('quote')) return 'quote_pdf';
    if (l.startsWith('inv-') || l.includes('invoice')) return 'other';
    return 'plan';
  }
  if (/\.(jpe?g|png|webp|heic|heif)$/.test(l)) {
    if (l.includes('before') || l.includes('start')) return 'before_photo';
    if (l.includes('after') || l.includes('final') || l.includes('done')) return 'after_photo';
    if (l.includes('progress') || l.includes('during') || l.includes('wip')) return 'process_photo';
    return 'scope_photo';
  }
  return 'other';
}

function isAttachmentFile(name: string): boolean {
  if (SKIP_NAMES.has(name.toLowerCase())) return false;
  if (name.startsWith('.')) return false; // .DS_Store etc
  return /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(name);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const businessId = process.env.TRADEPILOT_BUSINESS_ID;
  if (!url || !serviceKey || !businessId) {
    console.error('✗ Missing env. Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TRADEPILOT_BUSINESS_ID in .env.local.');
    process.exit(1);
  }

  const dir = path.resolve(process.argv[2] ?? './luke-lead');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`✗ Attachments folder not found: ${dir}`);
    console.error('  Download Luke\'s attachments from Gmail into a folder and pass its path:');
    console.error('    npx tsx scripts/backfill-luke-lead.ts ~/Downloads/luke-lead');
    process.exit(1);
  }

  const files = readdirSync(dir).filter(isAttachmentFile);
  const skipped = readdirSync(dir).filter((f) => !isAttachmentFile(f) && !f.startsWith('.'));
  console.log(`Folder: ${dir}`);
  console.log(`Attachments to upload (${files.length}): ${files.join(', ') || '(none)'}`);
  if (skipped.length) console.log(`Skipping (signature/non-file): ${skipped.join(', ')}`);
  if (files.length === 0) {
    console.error('✗ No image/PDF attachments found in that folder. Aborting.');
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 1. Find-or-create the lead (idempotent on client_email) ───────────────
  let jobId: string;
  const { data: existing, error: findErr } = await admin
    .from('jobs')
    .select('id')
    .eq('business_id', businessId)
    .eq('client_email', LEAD.clientEmail)
    .limit(1)
    .maybeSingle();
  if (findErr) { console.error('✗ Lookup failed:', findErr.message); process.exit(1); }

  if (existing) {
    jobId = existing.id as string;
    console.log(`↳ Reusing existing lead ${jobId} (matched on ${LEAD.clientEmail}).`);
  } else {
    const { data: inserted, error: insErr } = await admin
      .from('jobs')
      .insert({
        business_id: businessId,
        name: LEAD.name,
        client_name: LEAD.clientName,
        client_email: LEAD.clientEmail,
        client_phone: LEAD.clientPhone,
        location: LEAD.location,
        status: 'lead',
        source: 'email',
        notes: LEAD.notes,
      })
      .select('id')
      .single();
    if (insErr || !inserted) { console.error('✗ Lead insert failed:', insErr?.message); process.exit(1); }
    jobId = inserted.id as string;
    console.log(`✓ Created lead ${jobId}.`);
  }

  // ── 2. Ensure a stub draft quote to hang attachments off ──────────────────
  let quoteId: string;
  const { data: q, error: qFindErr } = await admin
    .from('quotes')
    .select('id')
    .eq('business_id', businessId)
    .eq('job_id', jobId)
    .limit(1)
    .maybeSingle();
  if (qFindErr) { console.error('✗ Quote lookup failed:', qFindErr.message); process.exit(1); }
  if (q) {
    quoteId = q.id as string;
  } else {
    const { data: newQ, error: qErr } = await admin
      .from('quotes')
      .insert({ business_id: businessId, job_id: jobId, job_address: LEAD.location, status: 'draft' })
      .select('id')
      .single();
    if (qErr || !newQ) { console.error('✗ Stub quote insert failed:', qErr?.message); process.exit(1); }
    quoteId = newQ.id as string;
  }
  console.log(`↳ Using quote ${quoteId} for attachments.`);

  // Existing attachment filenames on this quote — so re-runs don't duplicate.
  const { data: existingAtts } = await admin
    .from('quote_attachments')
    .select('file_name')
    .eq('quote_id', quoteId);
  const already = new Set((existingAtts ?? []).map((a) => (a.file_name as string) ?? ''));

  // ── 3. Upload each file + insert a quote_attachments row ───────────────────
  let saved = 0;
  for (const fileName of files) {
    if (already.has(fileName)) { console.log(`  · ${fileName} already attached — skipping.`); continue; }
    const bytes = readFileSync(path.join(dir, fileName));
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const storagePath = `${businessId}/${quoteId}/${crypto.randomUUID()}__${safeName}`;
    const kind = inferKind(fileName);

    const { error: upErr } = await admin.storage
      .from('quote-attachments')
      .upload(storagePath, bytes, { contentType: contentTypeFor(fileName), upsert: false });
    if (upErr) { console.error(`  ✗ upload failed for ${fileName}:`, upErr.message); continue; }

    const { error: attErr } = await admin
      .from('quote_attachments')
      .insert({ business_id: businessId, quote_id: quoteId, kind, storage_path: storagePath, file_name: fileName });
    if (attErr) {
      console.error(`  ✗ row insert failed for ${fileName}:`, attErr.message);
      await admin.storage.from('quote-attachments').remove([storagePath]).catch(() => {});
      continue;
    }
    console.log(`  ✓ ${fileName} → ${kind}`);
    saved++;
  }

  console.log(`\n✓ Done. Lead ${jobId}, ${saved} attachment(s) uploaded.`);
  console.log('  Open Jobs → Leads in the app (reload) → tap the lead → Plans + photos.');
  process.exit(0);
}

main().catch((err) => { console.error('Unhandled error:', err); process.exit(1); });
