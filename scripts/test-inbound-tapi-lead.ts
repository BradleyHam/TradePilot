// Smoke test for /api/webhooks/inbound-tapi-lead.
//
// Builds CloudMailin-shaped payloads from realistic Tapi "Provide a quote"
// emails, POSTs them at the local dev server, and verifies:
//   1. First POST creates a lead          (200 + jobId, dedup: undefined)
//   2. Same email again is deduped         (200 + dedup: true, same jobId)
//   3. A different address creates a lead  (200 + new jobId)
//   4. A non-quote Tapi email is skipped   (200 + skipped: true)
//   5. A bad secret is rejected            (401)
//
// Run with:
//   npx tsx scripts/test-inbound-tapi-lead.ts
//
// The dev server must be running (npm run dev). Needs TAPI_LEAD_WEBHOOK_SECRET
// in .env.local — the same secret the server checks. Point at prod by setting
// INBOUND_TAPI_ENDPOINT.

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

const ENDPOINT =
  process.env.INBOUND_TAPI_ENDPOINT ?? 'http://localhost:3000/api/webhooks/inbound-tapi-lead';

/** Build a Tapi quote-request plaintext body the way Tapi formats them. */
function quoteRequestPlain(opts: {
  pm: string;
  jobType: string;
  addressShort: string;
  message: string;
  agency: string;
}): string {
  return [
    '',
    '~~~ Provide a quote ~~~',
    '',
    'Hi Lakeside Painting,',
    '',
    `${opts.pm} has requested a quote for this job:`,
    '',
    opts.jobType,
    opts.addressShort,
    '',
    `Message from ${opts.pm}:`,
    '',
    opts.message,
    '',
    'Please provide a quote for this job through this online form:',
    '',
    'View full job &amp; enter quote – open this link:',
    'https://url6277.tapihq.com/ls/click?upn=u001.SMOKE-TEST-LINK',
    '',
    '',
    'Regards,',
    opts.agency,
    '',
    '~~~',
    'Powered by Tapi.',
  ].join('\r\n');
}

function buildPayload(opts: {
  subject: string;
  plain: string;
  fromAddress?: string;
}) {
  return {
    envelope: { from: opts.fromAddress ?? 'hi@tapihq.com', to: 'leads@lakeside.example' },
    headers: {
      'Message-ID': `<tapi-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local>`,
      From: opts.fromAddress ?? 'hi@tapihq.com',
      Subject: opts.subject,
      Date: new Date().toUTCString(),
    },
    subject: opts.subject,
    plain: opts.plain,
    html: '',
  };
}

async function post(body: unknown, secret: string): Promise<{ status: number; body: Record<string, unknown> }> {
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
  const secret = process.env.TAPI_LEAD_WEBHOOK_SECRET;
  if (!secret) {
    console.error('TAPI_LEAD_WEBHOOK_SECRET not set in .env.local. Aborting.');
    process.exit(1);
  }

  const faulks = buildPayload({
    subject: 'Provide a quote for 41 Faulks Terrace, Wanaka',
    plain: quoteRequestPlain({
      pm: 'Colleen',
      jobType: 'Interior Re-paint',
      addressShort: '41 Faulks Terrace',
      message:
        'The house is currently occupied by the people who have sold it. Vacant from +/- 8 June.\nCurrent owner phone number - Melissa 0212783202.',
      agency: 'Home &amp; Co',
    }),
  });

  console.log('▶ First POST (expect new lead)…');
  const r1 = await post(faulks, secret);
  console.log('  ↳', r1.status, r1.body);
  if (r1.status !== 200 || !r1.body.ok || !r1.body.jobId || r1.body.dedup) {
    console.error('✗ Expected 200 + jobId (no dedup). Aborting.');
    process.exit(1);
  }
  const firstId = r1.body.jobId;

  console.log('\n▶ Second POST, same address (expect dedup)…');
  const r2 = await post(faulks, secret);
  console.log('  ↳', r2.status, r2.body);
  if (r2.status !== 200 || !r2.body.ok || !r2.body.dedup || r2.body.jobId !== firstId) {
    console.error('✗ Expected 200 + dedup:true + same jobId.');
    process.exit(1);
  }

  console.log('\n▶ Third POST, different address (expect new lead)…');
  const cairnmuir = buildPayload({
    subject: 'Provide a quote for 7 Cairnmuir Street, Wanaka',
    plain: quoteRequestPlain({
      pm: 'Jess',
      jobType: 'Ceiling Protector',
      addressShort: '7 Cairnmuir Street',
      message: 'Just looking for a quote to have a protective coat done on the ceiling.',
      agency: 'Home &amp; Co',
    }),
  });
  const r3 = await post(cairnmuir, secret);
  console.log('  ↳', r3.status, r3.body);
  if (r3.status !== 200 || !r3.body.ok || !r3.body.jobId || r3.body.jobId === firstId) {
    console.error('✗ Expected 200 + new jobId.');
    process.exit(1);
  }

  console.log('\n▶ Non-quote Tapi email (expect skipped)…');
  const accepted = buildPayload({
    subject: '[RBWO011229] Quote accepted for work at 10 McLeod Avenue, Wanaka',
    plain: 'Hi Lakeside Painting,\r\nToni has accepted a quote you have provided.\r\nQuote for cedar\r\n10 McLeod Avenue\r\nRegards,\r\nHome & Co',
  });
  const r4 = await post(accepted, secret);
  console.log('  ↳', r4.status, r4.body);
  if (r4.status !== 200 || !r4.body.ok || !r4.body.skipped) {
    console.error('✗ Expected 200 + skipped:true for a non-quote-request email.');
    process.exit(1);
  }

  console.log('\n▶ Bad-secret rejection check…');
  const r5 = await post(faulks, 'definitely-wrong');
  console.log('  ↳', r5.status, r5.body);
  if (r5.status !== 401) {
    console.error('✗ Expected 401 for bad secret.');
    process.exit(1);
  }

  console.log('\n✓ All inbound-tapi-lead smoke tests passed.');
  console.log(`  Created leads: ${firstId}, ${r3.body.jobId}`);
  console.log('  Open the Jobs → Leads tab in the app to see them.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
