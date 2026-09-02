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
  if (!UUID.test(token)) return json({ ok: false, error: 'This approval link is not valid.' }, 404);

  let body: { response?: unknown };
  try {
    body = await request.json() as { response?: unknown };
  } catch {
    return json({ ok: false, error: 'Invalid response.' }, 400);
  }
  if (body.response !== 'approved' && body.response !== 'declined') {
    return json({ ok: false, error: 'Choose approve or decline.' }, 400);
  }

  const { data, error } = await supabaseAdmin.rpc('respond_to_job_variation', {
    p_token: token,
    p_response: body.response,
  });
  if (error) {
    console.error('[public variation response] failed:', error);
    const message = error.message ?? '';
    if (message.includes('not found')) return json({ ok: false, error: 'This approval link was not found.' }, 404);
    if (message.includes('not open')) return json({ ok: false, error: 'This variation is no longer open.' }, 409);
    if (message.includes('no agreed price')) return json({ ok: false, error: 'The job price needs correcting before this can be approved.' }, 409);
    return json({ ok: false, error: 'Your response was not saved. Please try again.' }, 500);
  }

  const payload = data as {
    variation?: { id?: string; business_id?: string; job_id?: string; title?: string; status?: string };
    job?: { id?: string; business_id?: string; name?: string; quote_amount?: number | string | null };
    already_responded?: boolean;
  } | null;
  const alreadyResponded = payload?.already_responded === true;
  const jobId = payload?.job?.id ?? payload?.variation?.job_id;
  const businessId = payload?.job?.business_id ?? payload?.variation?.business_id;
  const variationId = payload?.variation?.id;

  if (!alreadyResponded && jobId && businessId && variationId) {
    const activityKind = body.response === 'approved' ? 'variation-approved' : 'variation-declined';
    const { error: linkUpdateError } = await supabaseAdmin
      .from('job_client_links')
      .update({ last_activity_at: new Date().toISOString(), last_activity_kind: activityKind })
      .eq('business_id', businessId)
      .eq('job_id', jobId);
    // A missing 052 migration must not undo a variation response that was
    // already committed atomically by 051.
    if (linkUpdateError) console.warn('[public variation response] client-link activity update failed:', linkUpdateError.message);

    await sendBusinessNotificationSafe(supabaseAdmin, businessId, {
      ruleKey: `client-variation-${body.response}`,
      dedupeKey: variationId,
      title: body.response === 'approved' ? 'Extra work approved' : 'Extra work declined',
      body: `${payload?.variation?.title ?? 'The variation'} on ${payload?.job?.name ?? 'the job'} was ${body.response}.`,
      url: '/jobs',
      tag: `client-variation-${variationId}`,
    });
  }

  return json({
    ok: true,
    status: payload?.variation?.status ?? body.response,
    newJobTotalExGst: payload?.job?.quote_amount ?? null,
    alreadyResponded,
  });
}
