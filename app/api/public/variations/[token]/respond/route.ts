import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

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
    variation?: { status?: string };
    job?: { quote_amount?: number | string | null };
    already_responded?: boolean;
  } | null;
  return json({
    ok: true,
    status: payload?.variation?.status ?? body.response,
    newJobTotalExGst: payload?.job?.quote_amount ?? null,
    alreadyResponded: payload?.already_responded === true,
  });
}
