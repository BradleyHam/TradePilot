import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const hit = s => { s=JSON.stringify(s).toLowerCase(); return s.includes('anna')||s.includes('avalanche')||s.includes(' ross')||s.includes('"ross'); };
for (const t of ['quotes','entries','jobs','schedule_items','materials']) {
  const { data, error } = await sb.from(t).select('*');
  if (error) { console.log(t, 'ERR', error.message); continue; }
  const hits = (data||[]).filter(hit);
  if (hits.length) { console.log('=== '+t+' ('+hits.length+') ==='); console.log(JSON.stringify(hits,null,2)); }
}
