import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config({ path: '/sessions/amazing-kind-darwin/mnt/TradePilot/.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: quotes, error } = await sb.from('quotes').select('*').order('created_at', { ascending: false }).limit(8);
if (error) console.error('quotes err', error.message);
else for (const q of quotes) console.log(JSON.stringify(q).slice(0,300));
