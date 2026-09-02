import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { sendBusinessNotificationSafe } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!UUID.test(token)) return json({ ok: false, error: 'This private job link is not valid.' }, 404);

  let body: { acceptedBy?: unknown };
  try {
    body = await request.json() as { acceptedBy?: unknown };
  } catch {
    return json({ ok: false, error: 'Invalid response.' }, 400);
  }

  const acceptedBy = typeof body.acceptedBy === 'string' ? body.acceptedBy.trim() : '';
  if (acceptedBy.length < 2 || acceptedBy.length > 120) {
    return json({ ok: false, error: 'Please type your name before approving.' }, 400);
  }

  const { data, error } = await supabaseAdmin.rpc('respond_to_client_quote', {
    p_token: token,
    p_accepted_by: acceptedBy,
  });
  if (error) {
    console.error('[client quote acceptance] failed:', error);
    const message = (error.message ?? '').toLowerCase();
    if (message.includes('not found')) return json({ ok: false, error: 'This private job link is not available.' }, 404);
    if (message.includes('not open')) return json({ ok: false, error: 'This quote is no longer open for approval.' }, 409);
    if (message.includes('no agreed price')) return json({ ok: false, error: 'The quote price needs correcting before it can be approved.' }, 409);
    return json({ ok: false, error: 'Your approval was not saved. Please try again.' }, 500);
  }

  const payload = data as {
    link?: { quote_accepted_at?: string | null; quote_accepted_by?: string | null };
    job?: { id?: string; business_id?: string; name?: string; status?: string };
    already_responded?: boolean;
  } | null;
  const alreadyResponded = payload?.already_responded === true;
  const jobId = payload?.job?.id;
  const businessId = payload?.job?.business_id;

  if (!alreadyResponded && jobId && businessId) {
    await sendBusinessNotificationSafe(supabaseAdmin, businessId, {
      ruleKey: 'client-quote-approved',
      dedupeKey: jobId,
      title: 'Quote approved',
      body: `${acceptedBy} approved ${payload?.job?.name ?? 'the job'} online.`,
      url: '/jobs',
      tag: `client-quote-${jobId}`,
    });
  }

  return json({
    ok: true,
    status: payload?.job?.status ?? 'accepted',
    acceptedAt: payload?.link?.quote_accepted_at ?? null,
    acceptedBy: payload?.link?.quote_accepted_by ?? acceptedBy,
    alreadyResponded,
  });
}
