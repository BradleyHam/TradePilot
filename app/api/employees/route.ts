// POST   /api/employees  — owner creates an employee login + membership
// DELETE /api/employees  — owner revokes an employee's access
//
// This is the ONLY place the app creates a login. It runs server-side with
// the service-role key (never exposed to the browser) so Brad never has to
// touch the Supabase dashboard.
//
// SAFETY:
//   1. Caller must send Authorization: Bearer <supabase token>.
//   2. The token's user MUST be the OWNER of a business (businesses.owner_id
//      = them). Anyone else — including an existing employee — is rejected.
//      So an employee can never mint another login or escalate.
//   3. New logins are always role='employee'. This route cannot create an
//      owner.
//
// Returns:
//   200 { ok: true, employee }              (created / revoked)
//   400 invalid payload
//   401 missing/invalid token
//   403 caller is not an owner
//   409 email already in use
//   500 server misconfig / unexpected

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_WORKER_KINDS = ['owner', 'experienced', 'apprentice', 'helper', 'subcontractor'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Verify the bearer token and return the OWNER's business id, or an error. */
async function resolveOwner(req: Request): Promise<
  | { ok: true; userId: string; businessId: string }
  | { ok: false; status: number; error: string }
> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  if (!token) return { ok: false, status: 401, error: 'Missing Authorization: Bearer <token> header.' };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { ok: false, status: 500, error: 'Server misconfigured: Supabase env vars missing.' };

  const verifier = createClient(url, anonKey);
  const { data: userData, error: userErr } = await verifier.auth.getUser(token);
  if (userErr || !userData.user) return { ok: false, status: 401, error: 'Invalid or expired auth token.' };

  // Canonical owner check: businesses.owner_id. Uses the admin client so
  // the lookup isn't itself subject to RLS.
  const { data: biz, error: bizErr } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('owner_id', userData.user.id)
    .limit(1);
  if (bizErr) return { ok: false, status: 500, error: bizErr.message };
  if (!biz || biz.length === 0) return { ok: false, status: 403, error: 'Only the business owner can manage employees.' };

  return { ok: true, userId: userData.user.id, businessId: biz[0].id as string };
}

export async function POST(req: Request) {
  const owner = await resolveOwner(req);
  if (!owner.ok) return NextResponse.json({ ok: false, error: owner.error }, { status: owner.status });

  let body: { email?: string; password?: string; displayName?: string; workerKind?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const displayName = (body.displayName ?? '').trim();
  const workerKind = (body.workerKind ?? 'helper').trim();

  if (!EMAIL_RE.test(email)) return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ ok: false, error: 'Password must be at least 8 characters.' }, { status: 400 });
  if (!displayName) return NextResponse.json({ ok: false, error: 'Enter the employee’s name.' }, { status: 400 });
  if (!ALLOWED_WORKER_KINDS.includes(workerKind)) {
    return NextResponse.json({ ok: false, error: 'Invalid worker kind.' }, { status: 400 });
  }

  // 1. Create the auth login (email pre-confirmed — no verification email).
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (createErr || !created.user) {
    const msg = createErr?.message ?? 'Failed to create login.';
    const already = /already|exist|registered/i.test(msg);
    return NextResponse.json({ ok: false, error: already ? 'That email already has a login.' : msg }, { status: already ? 409 : 500 });
  }

  // 2. Link them to the owner's business as an employee.
  const { error: memErr } = await supabaseAdmin.from('business_members').insert({
    business_id: owner.businessId,
    user_id: created.user.id,
    role: 'employee',
    display_name: displayName,
    worker_kind: workerKind,
  });
  if (memErr) {
    // Roll back the orphaned auth user so a retry isn't blocked by a
    // half-created account.
    await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
    return NextResponse.json({ ok: false, error: `Login created but linking failed: ${memErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    employee: { userId: created.user.id, email, displayName, workerKind, role: 'employee' },
  });
}

export async function DELETE(req: Request) {
  const owner = await resolveOwner(req);
  if (!owner.ok) return NextResponse.json({ ok: false, error: owner.error }, { status: owner.status });

  let body: { userId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  const targetUserId = (body.userId ?? '').trim();
  if (!targetUserId) return NextResponse.json({ ok: false, error: 'Missing userId.' }, { status: 400 });
  if (targetUserId === owner.userId) {
    return NextResponse.json({ ok: false, error: 'You can’t remove yourself.' }, { status: 400 });
  }

  // Revoke access by removing the membership (never touches the owner row;
  // the role filter is belt-and-braces). We deliberately DON'T delete the
  // auth user — that would trip the entries.logged_by_user_id FK if they've
  // logged hours. Without a membership they can sign in but see nothing.
  const { error: delErr } = await supabaseAdmin
    .from('business_members')
    .delete()
    .eq('business_id', owner.businessId)
    .eq('user_id', targetUserId)
    .eq('role', 'employee');
  if (delErr) return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
