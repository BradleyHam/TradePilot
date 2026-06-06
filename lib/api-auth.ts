// Shared Bearer-token auth for API routes. Mirrors the inline check in
// /api/parse-bill: verify the caller's Supabase access token with a transient
// anon client (NOT the admin client, which bypasses RLS) so anonymous callers
// can't burn our Anthropic credits or trigger a publish.

import { createClient } from '@supabase/supabase-js';

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

export async function verifyBearer(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  if (!token) {
    return { ok: false, status: 401, error: 'Missing Authorization: Bearer <token> header.' };
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return { ok: false, status: 500, error: 'Server misconfigured: Supabase env vars missing.' };
  }
  const verifier = createClient(url, anon);
  const { data, error } = await verifier.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, status: 401, error: 'Invalid or expired auth token.' };
  }
  return { ok: true, userId: data.user.id };
}
