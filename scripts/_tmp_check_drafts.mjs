import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const businessId = process.env.TRADEPILOT_BUSINESS_ID;

// 1. All draft bills
const { data: drafts, error: e1 } = await supa
  .from('entries')
  .select('id, created_at, supplier, company, amount, source_message_id, bill_pdf_url, parser_confidence, is_draft, type')
  .eq('business_id', businessId)
  .eq('is_draft', true)
  .order('created_at', { ascending: false })
  .limit(20);
console.log('=== Draft bills (is_draft=true):', e1 ? 'ERROR ' + e1.message : `${drafts.length} rows`);
for (const d of drafts ?? []) {
  console.log(`  ${d.created_at}  ${d.supplier || d.company || '(no supplier)'}  $${d.amount}  pdf=${d.bill_pdf_url ? 'yes' : 'no'}  msg=${d.source_message_id ? d.source_message_id.slice(0, 40) : 'null'}`);
}

// 2. Any entries with source_message_id (i.e. arrived via webhook), draft or not
const { data: webhookEntries, error: e2 } = await supa
  .from('entries')
  .select('id, created_at, supplier, company, amount, source_message_id, is_draft, type, paid')
  .eq('business_id', businessId)
  .not('source_message_id', 'is', null)
  .order('created_at', { ascending: false })
  .limit(20);
console.log('\n=== Webhook-sourced entries (any source_message_id):', e2 ? 'ERROR ' + e2.message : `${webhookEntries.length} rows`);
for (const d of webhookEntries ?? []) {
  console.log(`  ${d.created_at}  ${d.supplier || d.company || '(no supplier)'}  $${d.amount}  draft=${d.is_draft}  paid=${d.paid}`);
}

// 3. Recent bills overall (last 10), to see what's flowing in
const { data: recentBills } = await supa
  .from('entries')
  .select('id, created_at, supplier, company, amount, source_message_id, is_draft, paid')
  .eq('business_id', businessId)
  .eq('type', 'bill')
  .order('created_at', { ascending: false })
  .limit(10);
console.log('\n=== 10 most recent bills (any source):');
for (const d of recentBills ?? []) {
  const src = d.source_message_id ? 'webhook' : 'manual';
  console.log(`  ${d.created_at}  ${d.supplier || d.company}  $${d.amount}  src=${src}  draft=${d.is_draft}`);
}
