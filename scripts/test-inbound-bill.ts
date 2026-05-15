// Smoke test for /api/webhooks/inbound-bill.
//
// Constructs a CloudMailin-shaped JSON payload using a real PDF, POSTs
// it twice against the local dev server, and verifies:
//   1. First POST creates a draft (200 + entryId, dedup: undefined)
//   2. Second POST is recognised as a duplicate (200 + dedup: true,
//      same entryId)
//   3. Third POST with a NEW message-id creates another draft
//
// Run with:
//   npx tsx scripts/test-inbound-bill.ts <path/to/bill.pdf>
//
// Defaults to the Resene fixture if no path is provided. The dev server
// must be running (npm run dev) for the request to land. The script
// needs INBOUND_BILL_WEBHOOK_SECRET in .env.local — same secret the
// server checks against.

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PDF = './data/test/resene-invoice-424640171.pdf';
const ENDPOINT = process.env.INBOUND_BILL_ENDPOINT
  ?? 'http://localhost:3000/api/webhooks/inbound-bill';

async function main() {
  const secret = process.env.INBOUND_BILL_WEBHOOK_SECRET;
  if (!secret) {
    console.error('INBOUND_BILL_WEBHOOK_SECRET not set in .env.local. Aborting.');
    process.exit(1);
  }

  const pdfPath = process.argv[2] ?? DEFAULT_PDF;
  const absPath = resolve(pdfPath);
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = readFileSync(absPath);
  } catch (err) {
    console.error(`Couldn't read PDF at ${absPath}:`, err);
    console.error('Hint: pass a path as the first argument, or place the test PDF at the default location.');
    process.exit(1);
  }
  console.log(`▶ Using PDF: ${absPath} (${pdfBuffer.length} bytes)`);

  const base64 = pdfBuffer.toString('base64');
  // Use a fresh, unique Message-ID per test run so we don't collide with
  // prior runs. Real Gmail Message-IDs look like
  // <CAFx2Wq8nL+abc123@mail.gmail.com>.
  const runId = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messageId = `<${runId}@test.local>`;

  const payload = buildCloudMailinPayload({
    messageId,
    fromAddress: 'accounts@resene.co.nz',
    subject: 'Resene invoice 424640171',
    base64,
    fileName: 'Invoice 424640171.pdf',
  });

  console.log(`\n▶ First POST (expect new draft)…`);
  const r1 = await post(payload, secret);
  console.log('  ↳', r1.status, r1.body);
  if (r1.status !== 200 || !r1.body.ok || !r1.body.entryId) {
    console.error('✗ Expected 200 + entryId. Aborting.');
    process.exit(1);
  }
  const firstId = r1.body.entryId;
  if (r1.body.dedup) {
    console.error('✗ First POST reported dedup=true (was the Message-ID re-used?). Aborting.');
    process.exit(1);
  }

  console.log(`\n▶ Second POST with same Message-ID (expect dedup)…`);
  const r2 = await post(payload, secret);
  console.log('  ↳', r2.status, r2.body);
  if (r2.status !== 200 || !r2.body.ok || !r2.body.dedup || r2.body.entryId !== firstId) {
    console.error('✗ Expected 200 + dedup:true + same entryId.');
    process.exit(1);
  }

  console.log(`\n▶ Third POST with new Message-ID (expect new draft)…`);
  const payload2 = { ...payload, headers: { ...payload.headers, 'Message-ID': `<smoke-${Date.now()}-second@test.local>` } };
  const r3 = await post(payload2, secret);
  console.log('  ↳', r3.status, r3.body);
  if (r3.status !== 200 || !r3.body.ok || !r3.body.entryId || r3.body.entryId === firstId) {
    console.error('✗ Expected 200 + new entryId.');
    process.exit(1);
  }

  console.log('\n▶ Bad-secret rejection check…');
  const r4 = await post(payload, 'definitely-wrong');
  console.log('  ↳', r4.status, r4.body);
  if (r4.status !== 401) {
    console.error('✗ Expected 401 for bad secret.');
    process.exit(1);
  }

  console.log('\n✓ All inbound-bill smoke tests passed.');
  console.log(`  Created drafts: ${firstId}, ${r3.body.entryId}`);
  console.log(`  Visit /home in the app to see them in the "Bills to confirm" flag.`);
  process.exit(0);
}

function buildCloudMailinPayload(opts: {
  messageId: string;
  fromAddress: string;
  subject: string;
  base64: string;
  fileName: string;
}) {
  return {
    envelope: {
      from: opts.fromAddress,
      to: 'bills@lakeside.example',
    },
    headers: {
      'Message-ID': opts.messageId,
      From: opts.fromAddress,
      Subject: opts.subject,
      Date: new Date().toUTCString(),
    },
    plain: `Please find attached invoice. (Smoke test ${opts.messageId})`,
    html: '<p>See attached PDF.</p>',
    attachments: [
      {
        file_name: opts.fileName,
        content_type: 'application/pdf',
        content: opts.base64,
        size: Math.floor(opts.base64.length * 0.75), // approx decoded size
      },
    ],
  };
}

async function post(body: unknown, secret: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': secret,
    },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = await res.json();
  } catch {
    parsed = { _nonJsonResponse: await res.text() };
  }
  return { status: res.status, body: parsed };
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
