import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config({ path: '/sessions/bold-fervent-heisenberg/mnt/TradePilot/.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb.from('jobs').select('id,name,client_name,client_email,status,source,created_at,location').order('created_at', { ascending: false });
if (error) { console.error(error); process.exit(1); }
for (const j of data) console.log([j.status, j.source, (j.created_at||'').slice(0,10), j.name, j.client_name, j.client_email, j.location].join(' | '));
console.log('TOTAL', data.length);
