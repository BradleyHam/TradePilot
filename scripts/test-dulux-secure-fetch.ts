// Smoke test for the Dulux secure-link PDF unlock.
//
//   npx tsx scripts/test-dulux-secure-fetch.ts <shortLink> <accountNumber>
//
// e.g.
//   npx tsx scripts/test-dulux-secure-fetch.ts \
//     https://e.duluxgroup.com.au/t/s/77YyuztWI7 146009
//
// Exercises the real two-request exchange against Dulux's live endpoint and
// reports whether a PDF came back (and its size / %PDF magic). Use a fresh
// secure link from a recent Dulux invoice email — tokens live for weeks but
// not forever. The account number is your Dulux customer number (printed on
// every invoice). Falls back to DULUX_ACCOUNT_NUMBER from the env if the
// second arg is omitted.

import 'dotenv/config';
import { fetchDuluxSecurePdf, extractDuluxShortLink } from '@/lib/dulux-secure-fetch';

async function main() {
  const arg = process.argv[2];
  const account = process.argv[3] ?? process.env.DULUX_ACCOUNT_NUMBER ?? '';
  if (!arg) {
    console.error('Usage: tsx scripts/test-dulux-secure-fetch.ts <shortLink|emailBodyText> <accountNumber?>');
    process.exit(1);
  }
  if (!account) {
    console.error('No account number given and DULUX_ACCOUNT_NUMBER is not set.');
    process.exit(1);
  }

  // Accept either a bare short link or a blob of email text to extract from.
  const link = arg.startsWith('http') ? arg : extractDuluxShortLink({ plain: arg });
  if (!link) {
    console.error('Could not find a Dulux secure short link in the input.');
    process.exit(1);
  }
  console.log('Short link:', link);
  console.log('Account   :', account.replace(/.(?=.{2})/g, '*')); // mask all but last 2

  const res = await fetchDuluxSecurePdf(link, account);
  if (res.pdf) {
    const magic = res.pdf.subarray(0, 5).toString('latin1');
    console.log('✅ SUCCESS');
    console.log('   bytes   :', res.pdf.length);
    console.log('   magic   :', JSON.stringify(magic), magic === '%PDF-' ? '(valid PDF)' : '(NOT a PDF!)');
    console.log('   finalUrl:', res.finalUrl);
  } else {
    console.log('❌ FAILED');
    console.log('   reason  :', res.reason);
    console.log('   detail  :', res.detail);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
