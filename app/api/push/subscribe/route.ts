// POST   /api/push/subscribe — save this device's push subscription
// DELETE /api/push/subscribe — remove it (user turned notifications off)
//
// Called from the Settings "Notifications" row after the browser's
// pushManager.subscribe() succeeds. Auth mirrors /api/employees:
// bearer token verified against Supabase, caller must be the OWNER of
// a business (employees don't get push in v1 — the notification rules
// are all money/pipeline things they're deliberately blind to).
//
// The write uses the admin client (not the caller's RLS session)
// purely so this route stays symmetrical with the cron sender that
// reads the same table — the owner check above is the real gate.
//
// POST also fires a "Notifications are on" confirmation push at JUST
// the newly registered device: instant proof the whole pipeline works
// (VAPID keys, encryption, Apple/Google delivery) at the exact moment
// Brad is looking at his phone — not silence until 7am tomorrow.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { sendWebPush, vapidFromEnv } from '@/lib/web-push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Verify the bearer token belongs to a business OWNER (same as /api/employees). */
async function resolveOwner(req: Request): Promise<
  | { ok: true; businessId: string }
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

  const { data: biz, error: bizErr } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('owner_id', userData.user.id)
    .limit(1);
  if (bizErr) return { ok: false, status: 500, error: bizErr.message };
  if (!biz || biz.length === 0) return { ok: false, status: 403, error: 'Only the business owner can manage notifications.' };

  return { ok: true, businessId: biz[0].id as string };
}

interface SubscribeBody {
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  userAgent?: string;
}

export async function POST(req: Request) {
  const owner = await resolveOwner(req);
  if (!owner.ok) return NextResponse.json({ ok: false, error: owner.error }, { status: owner.status });

  let body: SubscribeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  const { endpoint, p256dh, auth } = body;
  if (!endpoint?.startsWith('https://') || !p256dh || !auth) {
    return NextResponse.json({ ok: false, error: 'Subscription needs endpoint, p256dh and auth.' }, { status: 400 });
  }

  // Endpoint is globally unique → natural upsert key. Re-enabling on
  // the same device refreshes the row instead of duplicating it.
  const { error: upsertErr } = await supabaseAdmin
    .from('push_subscriptions')
    .upsert(
      {
        business_id: owner.businessId,
        endpoint,
        p256dh,
        auth,
        user_agent: body.userAgent?.slice(0, 300) ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    );
  if (upsertErr) return NextResponse.json({ ok: false, error: upsertErr.message }, { status: 500 });

  // Confirmation push to this device only — best-effort, never fails
  // the subscribe itself.
  let confirmed = false;
  const vapid = vapidFromEnv();
  if (!('error' in vapid)) {
    try {
      const res = await sendWebPush(
        { endpoint, p256dh, auth },
        {
          title: 'Notifications are on',
          body: "You'll get a morning brief plus nudges for quotes, leads and IRD deadlines.",
          url: '/home',
        },
        vapid,
      );
      confirmed = res.ok;
    } catch (e) {
      console.error('[push] confirmation send failed (non-fatal):', e);
    }
  }

  return NextResponse.json({ ok: true, confirmed });
}

export async function DELETE(req: Request) {
  const owner = await resolveOwner(req);
  if (!owner.ok) return NextResponse.json({ ok: false, error: owner.error }, { status: owner.status });

  let body: { endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body.endpoint) return NextResponse.json({ ok: false, error: 'endpoint required.' }, { status: 400 });

  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .eq('business_id', owner.businessId)
    .eq('endpoint', body.endpoint);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
