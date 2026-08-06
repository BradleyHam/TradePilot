import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config({ path: './.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb.from('jobs')
  .select('id,legacy_id,name,client_name,status,location,quote_amount,invoice_amount,estimated_value,created_at,declined_at')
  .order('created_at', { ascending: false });
if (error) { console.error('ERR', error.message); process.exit(1); }
const OPEN = ['lead','quoted','accepted','booked','in-progress'];
console.log('=== OPEN JOBS ===');
for (const j of data.filter(j=>OPEN.includes(j.status) && !j.declined_at)) {
  console.log([j.status.padEnd(12), (j.legacy_id||'-').padEnd(5), (j.name||'').slice(0,40).padEnd(40), (j.client_name||'').slice(0,20).padEnd(20), (j.location||'').slice(0,20).padEnd(20), 'q:'+(j.quote_amount??'-'), 'est:'+(j.estimated_value??'-')].join(' | '));
}
const c={}; for (const j of data) c[j.status]=(c[j.status]||0)+1;
console.log('\nSTATUS COUNTS:', JSON.stringify(c), 'TOTAL', data.length);
