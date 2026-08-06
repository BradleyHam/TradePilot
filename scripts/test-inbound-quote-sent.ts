// Smoke test for /api/webhooks/inbound-quote-sent.
//
// Builds Apps-Script-shaped payloads (a quote email Brad SENT, body-text
// quote — no PDF, exercising the body fallback), POSTs them at the local
// dev server, and verifies:
//   1. A quote to an unknown recipient creates a quoted job (200 + jobId + created)
//   2. The same quote again is deduped                      (200 + dedup: true)
//   3. A quote to an EXISTING lead's email flips that lead  (200 + matched: 'client-email')
//      — only runs when TEST_LEAD_EMAIL is set to a real open lead's client email.
//   4. An email with no total and no matching lead is skipped (200 + skipped)
//   5. A bad secret is rejected                             (401)
//
// Run with:
//   npx tsx scripts/test-inbound-quote-sent.ts
//
// The dev server must be running (npm run dev). Needs QUOTE_SENT_WEBHOOK_SECRET
// and ANTHROPIC_API_KEY in .env.local (the route calls the model to parse).
// Point at prod by setting INBOUND_QUOTE_ENDPOINT.
//
// NOTE: steps 1/4 depend on live model judgement (like the email-lead test).
// The samples are written to be unambiguous. Step 1 creates a REAL job named
// "Exterior repaint — 99 Smoke Test Lane" — decline/delete it after testing.

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

const ENDPOINT =
  process.env.INBOUND_QUOTE_ENDPOINT ?? 'http://localhost:3000/api/webhooks/inbound-quote-sent';

function buildPayload(opts: {
  to: string;
  subject: string;
  plain: string;
  sentAt?: string;
}) {
  return {
    envelope: { from: 'Lakeside Painting <info@lakesidepainting.co.nz>', to: opts.to },
    headers: {
      message_id: `<quote-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local>`,
      subject: opts.subject,
      from: 'Lakeside Painting <info@lakesidepainting.co.nz>',
      to: opts.to,
    },
    sent_at: opts.sentAt ?? new Date().toISOString(),
    subject: opts.subject,
    plain: opts.plain,
    html: '',
    attachments: [],
  };
}

const QUOTE_BODY = [
  'Hi Sam,',
  '',
  'Thanks for having me around. Please find our quote below for the',
  'exterior repaint at 99 Smoke Test Lane, Wanaka.',
  '',
  'QUOTE QUO-999 — Lakeside Painting Ltd',
  'Client: Sam Smoketest',
  'Address: 99 Smoke Test Lane, Wanaka',
  'Date: 01/08/2026',
  '',
  'Scope: wash down, scrape and spot-prime weatherboards, two topcoats',
  'of Lumbersider to all exterior weatherboards, windows and soffits.',
  '',
  'Subtotal (ex GST): $8,400.00',
  'GST (15%): $1,260.00',
  'TOTAL (incl GST): $9,660.00',
  '',
  'Cheers,',
  'Brad',
].join('\n');

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
    parsed = await res.json() as Record<string, unknown>;
  } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

async function main() {
  const secret = process.env.QUOTE_SENT_WEBHOOK_SECRET;
  if (!secret) {
    console.error('QUOTE_SENT_WEBHOOK_SECRET not set in .env.local — cannot run.');
    process.exit(1);
  }
  console.log(`Target: ${ENDPOINT}\n`);

  // 1. Unknown recipient + full quote → creates a quoted job.
  console.log('1. Quote to unknown recipient → creates quoted job');
  const p1 = buildPayload({
    to: 'sam.smoketest@example.com',
    subject: 'Quote — exterior repaint, 99 Smoke Test Lane',
    plain: QUOTE_BODY,
  });
  const r1 = await post(p1, secret);
  check('returns 200', r1.status === 200, r1);
  check('created a job', r1.body.ok === true && Boolean(r1.body.jobId) && r1.body.created === true, r1.body);
  check('parsed the incl-GST total', r1.body.totalInclGst === 9660, r1.body);
  const createdJobId = r1.body.jobId;

  // 2. Same quote again → dedup (same client email, same-window quoted job).
  console.log('2. Same quote re-sent → dedup');
  const r2 = await post(buildPayload({
    to: 'sam.smoketest@example.com',
    subject: 'Quote — exterior repaint, 99 Smoke Test Lane',
    plain: QUOTE_BODY,
  }), secret);
  check('returns 200', r2.status === 200, r2);
  check('deduped to the same job', r2.body.dedup === true && r2.body.jobId === createdJobId, r2.body);

  // 3. Optional: flip a REAL existing lead by client email.
  const leadEmail = process.env.TEST_LEAD_EMAIL;
  if (leadEmail) {
    console.log(`3. Quote to existing lead (${leadEmail}) → matched + flipped`);
    const r3 = await post(buildPayload({
      to: leadEmail,
      subject: 'Quote — your painting job',
      plain: QUOTE_BODY.replace('99 Smoke Test Lane', 'your place'),
    }), secret);
    check('returns 200', r3.status === 200, r3);
    check('matched by client email', r3.body.matched === 'client-email', r3.body);
  } else {
    console.log('3. (skipped — set TEST_LEAD_EMAIL to a real open lead\'s email to test matching)');
  }

  // 4. No total, no match → precision gate skips it.
  console.log('4. Non-quote email → skipped');
  const r4 = await post(buildPayload({
    to: 'someone.else@example.com',
    subject: 'Re: catch up next week',
    plain: 'Hi mate, all good for Thursday arvo? I\'ll bring the trailer. Cheers, Brad',
  }), secret);
  check('returns 200', r4.status === 200, r4);
  check('skipped (no flip, no create)', r4.body.skipped === true, r4.body);

  // 5. Bad secret → 401.
  console.log('5. Bad secret → 401');
  const r5 = await post(p1, 'wrong-secret');
  check('returns 401', r5.status === 401, r5);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  if (createdJobId) {
    console.log(`\nClean-up: the test created job ${createdJobId} ("Exterior repaint — 99 Smoke Test Lane") — decline or delete it in the app.`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
