// Smoke test for /api/webhooks/inbound-email-lead.
//
// Builds CloudMailin-shaped payloads from realistic FORWARDED customer
// enquiries, POSTs them at the local dev server, and verifies:
//   1. First POST creates a lead          (200 + jobId, dedup: undefined)
//   2. Same email again is deduped         (200 + dedup: true, same jobId)
//   3. A different enquiry creates a lead   (200 + new jobId)
//   4. An obvious newsletter is skipped     (200 + skipped: true)
//   5. A bad secret is rejected             (401)
//
// Run with:
//   npx tsx scripts/test-inbound-email-lead.ts
//
// The dev server must be running (npm run dev). Needs EMAIL_LEAD_WEBHOOK_SECRET
// AND ANTHROPIC_API_KEY in .env.local (the route calls the model to parse).
// Point at prod by setting INBOUND_EMAIL_ENDPOINT.
//
// NOTE: unlike the Tapi test, parsing here is done by the LLM, so steps 1/3/4
// depend on model judgement. The sample emails are written to be unambiguous;
// if step 4 ever flakes it means the model erred towards "might be a lead"
// (by design — we'd rather over-capture than miss a real customer).

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

const ENDPOINT =
  process.env.INBOUND_EMAIL_ENDPOINT ?? 'http://localhost:3000/api/webhooks/inbound-email-lead';

/** A Gmail-style forwarded enquiry body. The REAL lead is inside the forward;
 *  the envelope/From is Brad's own inbox — exactly what the route must untangle. */
function forwardedEnquiry(opts: {
  fromName: string;
  fromEmail: string;
  originalSubject: string;
  body: string;
}): string {
  return [
    '---------- Forwarded message ----------',
    `From: ${opts.fromName} <${opts.fromEmail}>`,
    'Date: Mon, 15 Jun 2026 at 09:14',
    `Subject: ${opts.originalSubject}`,
    'To: Brad Hamilton <bradleyjamesham@gmail.com>',
    '',
    opts.body,
  ].join('\n');
}

function buildPayload(opts: {
  subject: string;
  plain: string;
  fromHeader?: string;
}) {
  // A manual Gmail forward: the outer envelope/From is Brad's inbox.
  const from = opts.fromHeader ?? 'Brad Hamilton <bradleyjamesham@gmail.com>';
  return {
    envelope: { from: 'bradleyjamesham@gmail.com', to: 'leads@lakeside.example' },
    headers: {
      'Message-ID': `<email-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local>`,
      From: from,
      Subject: opts.subject,
      Date: new Date().toUTCString(),
    },
    subject: opts.subject,
    plain: opts.plain,
    html: '',
  };
}

async function post(
  body: unknown,
  secret: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
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

async function main() {
  const secret = process.env.EMAIL_LEAD_WEBHOOK_SECRET;
  if (!secret) {
    console.error('EMAIL_LEAD_WEBHOOK_SECRET not set in .env.local. Aborting.');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.INBOUND_EMAIL_ENDPOINT) {
    console.warn('⚠ ANTHROPIC_API_KEY not set locally — the dev server route will fail to parse.');
  }

  const jane = buildPayload({
    subject: 'Fwd: Painting quote',
    plain: forwardedEnquiry({
      fromName: 'Jane Smith',
      fromEmail: 'jane.smith@gmail.com',
      originalSubject: 'Painting quote',
      body:
        "Hi there,\n\nWe've just bought a place at 14 Stone Street, Albert Town and the " +
        'interior needs a full repaint before we move in — 3 bedrooms, lounge and hallway, ' +
        'walls and ceilings. Could you come take a look and give us a quote?\n\n' +
        'Cheers\nJane\n021 555 0123',
    }),
  });

  console.log('▶ First POST (expect new lead)…');
  const r1 = await post(jane, secret);
  console.log('  ↳', r1.status, r1.body);
  if (r1.status !== 200 || !r1.body.ok || !r1.body.jobId || r1.body.dedup) {
    console.error('✗ Expected 200 + jobId (no dedup). Aborting.');
    process.exit(1);
  }
  const firstId = r1.body.jobId;

  console.log('\n▶ Second POST, same enquiry (expect dedup)…');
  const r2 = await post(jane, secret);
  console.log('  ↳', r2.status, r2.body);
  if (r2.status !== 200 || !r2.body.ok || !r2.body.dedup || r2.body.jobId !== firstId) {
    console.error('✗ Expected 200 + dedup:true + same jobId.');
    process.exit(1);
  }

  console.log('\n▶ Third POST, different enquiry (expect new lead)…');
  const dave = buildPayload({
    subject: 'Fwd: exterior repaint',
    plain: forwardedEnquiry({
      fromName: 'Dave Reynolds',
      fromEmail: 'dave.reynolds@outlook.com',
      originalSubject: 'exterior repaint',
      body:
        'Morning,\n\nLooking for a price to repaint the exterior weatherboards and ' +
        'eaves on our house at 3 Hunter Crescent, Wanaka. Two storeys. Keen to get it ' +
        'done before winter.\n\nThanks\nDave\n027 444 9988',
    }),
  });
  const r3 = await post(dave, secret);
  console.log('  ↳', r3.status, r3.body);
  if (r3.status !== 200 || !r3.body.ok || !r3.body.jobId || r3.body.jobId === firstId) {
    console.error('✗ Expected 200 + new jobId.');
    process.exit(1);
  }

  console.log('\n▶ Enquiry WITH attachments (expect new lead + attachments saved)…');
  // Two real enquiry files (a photo + a plan PDF) plus one inline signature
  // logo that must be skipped (disposition=inline / content_id set). Content is
  // just small placeholder bytes — the route uploads bytes, it doesn't validate
  // the file format.
  const tinyPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  const withAttachments = {
    ...buildPayload({
      subject: 'Fwd: Timber weatherboard restoration — photos + plan attached',
      plain: forwardedEnquiry({
        fromName: 'Priya Nair',
        fromEmail: 'priya.nair@example.com',
        originalSubject: 'Timber weatherboard restoration',
        body:
          'Hi,\n\nWe are restoring the timber weatherboards at 5 Rata Lane, Hawea. Photos ' +
          'and the plan showing the walls to be retained are attached. Could you advise an ' +
          'approach and ballpark cost?\n\nThanks\nPriya\n021 777 6655',
      }),
    }),
    attachments: [
      { file_name: 'IMG_2297.JPG', content_type: 'image/jpeg', content: tinyPng, size: 1024 },
      { file_name: 'site-plan-consultant-issue.pdf', content_type: 'application/pdf', content: tinyPdf, size: 2048 },
      // Inline email-signature logo — must be skipped.
      { file_name: 'image001.png', content_type: 'image/png', content: tinyPng, size: 512, disposition: 'inline', content_id: '<image001.png@sig>' },
    ],
  };
  const rA = await post(withAttachments, secret);
  console.log('  ↳', rA.status, rA.body);
  const att = rA.body.attachments as { saved?: number; skipped?: number } | undefined;
  if (rA.status !== 200 || !rA.body.ok || !rA.body.jobId || rA.body.dedup) {
    console.error('✗ Expected 200 + new jobId for the attachment enquiry.');
    process.exit(1);
  }
  if (!att || att.saved !== 2 || (att.skipped ?? 0) < 1) {
    console.error('✗ Expected attachments {saved:2, skipped>=1} (2 real files kept, inline logo skipped).');
    process.exit(1);
  }

  console.log('\n▶ Obvious newsletter (expect skipped)…');
  const newsletter = buildPayload({
    subject: 'Fwd: 20% off all Resene paints this weekend only! 🎨',
    fromHeader: 'Resene Specials <specials@email.resene.co.nz>',
    plain:
      'WEEKEND SALE — 20% off all Resene testpots and premium paints in-store and online.\n' +
      'Shop now at resene.co.nz. Offer ends Sunday.\n\n' +
      'You are receiving this because you signed up to Resene news.\n' +
      'Unsubscribe | Update preferences | View in browser',
  });
  const r4 = await post(newsletter, secret);
  console.log('  ↳', r4.status, r4.body);
  if (r4.status !== 200 || !r4.body.ok || !r4.body.skipped) {
    console.error('✗ Expected 200 + skipped:true for an obvious newsletter.');
    process.exit(1);
  }

  console.log('\n▶ Bad-secret rejection check…');
  const r5 = await post(jane, 'definitely-wrong');
  console.log('  ↳', r5.status, r5.body);
  if (r5.status !== 401) {
    console.error('✗ Expected 401 for bad secret.');
    process.exit(1);
  }

  console.log('\n✓ All inbound-email-lead smoke tests passed.');
  console.log(`  Created leads: ${firstId}, ${r3.body.jobId}`);
  console.log('  Open the Jobs → Leads tab in the app to see them.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
