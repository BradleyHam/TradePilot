// Browser-side Supabase client. Uses the anon key + RLS for authorization.
// Import this from client components ('use client').

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Lazily construct the client so that importing this module at build time
// (e.g. during Next.js static prerender) doesn't crash when env vars are
// momentarily unavailable. The throw still fires at the call-site if anyone
// genuinely tries to use Supabase without configuration.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase env vars. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local',
    );
  }
  _client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return _client;
}

// Proxy so existing `import { supabase } from '@/lib/supabase/client'` keeps
// working without touching every call site. Property access lazily resolves
// the real client.
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
