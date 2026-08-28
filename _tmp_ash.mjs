import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
for (const line of readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^"|"$/g,'');
}
console.log('url set:', !!process.env.NEXT_PUBLIC_SUPABASE_URL, 'key set:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const r1 = await sb.from('jobs').select('*').ilike('client_name','%parrot%');
console.log('jobs err:', r1.error?.message, 'count:', r1.data?.length);
console.log(JSON.stringify(r1.data, null, 1));
for (const j of r1.data ?? []) {
  const r2 = await sb.from('invoices').select('*').eq('job_id', j.id);
  console.log('INVOICES err:', r2.error?.message, JSON.stringify(r2.data, null, 1));
}
const r3 = await sb.from('invoices').select('invoice_number,issue_date,kind,paid,amount_ex_gst').order('issue_date',{ascending:false}).limit(8);
console.log('RECENT err:', r3.error?.message, JSON.stringify(r3.data));
