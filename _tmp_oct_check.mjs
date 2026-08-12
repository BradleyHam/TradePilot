import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config({ path: '/sessions/focused-quirky-galileo/mnt/TradePilot/.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: jobs, error: je } = await sb.from('jobs').select('*').in('status', ['accepted','booked','in-progress','quoted','lead']);
if (je) console.log('jobs ERR', je.message);
console.log('=== OPEN/UPCOMING JOBS ===');
for (const j of jobs || []) {
  console.log([j.legacy_id, j.status, j.name, j.client_name, j.location, 'quote:'+j.quote_amount, (j.notes||'').slice(0,150).replace(/\n/g,' ')].join(' | '));
}

const { data: sched, error: se } = await sb.from('schedule_items').select('*').gte('date', '2026-08-01').lte('date', '2026-12-31').order('date');
if (se) console.log('sched ERR', se.message);
console.log('\n=== SCHEDULE Aug-Dec 2026 ===');
for (const s of sched || []) console.log(JSON.stringify(s).slice(0, 300));
