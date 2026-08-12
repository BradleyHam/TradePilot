// GET /api/cron/notifications — the daily notification engine
//
// Triggered by Vercel Cron (see vercel.json) once a day at 18:45 UTC
// ≈ 6:45am NZST / 7:45am NZDT — "with your first coffee" either side
// of daylight saving. Hobby-tier cron only guarantees once daily, so
// every rule is written to survive a late or missed run (state-based
// conditions + once-only dedupe keys, not exact-day matches).
//
// Flow:
//   1. Auth — Vercel sends `Authorization: Bearer <CRON_SECRET>`
//      automatically when the env var is set. `?token=` is accepted
//      too for manual testing from a browser.
//   2. Bail early (cheap) if no device has notifications turned on.
//   3. Load the world: open-pipeline jobs, today's schedule, bills,
//      pay runs — via the service-role client + the SAME row mappers
//      the store uses, so rule logic reads camelCase like everywhere
//      else.
//   4. Evaluate lib/notification-rules.ts, send through
//      lib/push-notify.ts (which dedupes via notification_log), cap
//      the per-run sends so a backlog can't turn into a push storm.
//
// Manual test: open /api/cron/notifications?token=<CRON_SECRET> — the
// JSON response says what fired, what was deduped, what was skipped.

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { rowToEntry, rowToJob, rowToPayRun, rowToScheduleItem } from '@/lib/supabase/mappers';
import { evaluateNotificationRules } from '@/lib/notification-rules';
import { sendBusinessNotification } from '@/lib/push-notify';
import { secretMatches } from '@/lib/webhook-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// First morning after enabling push, months of overdue states can all
// become sendable at once. Six is a wake-up; sixteen is an uninstall.
// The rest fire on following days (dedupe keys keep order stable).
const MAX_SENDS_PER_RUN = 6;

/** Today as an ISO date in NZ local time, regardless of server TZ. */
function nzTodayISO(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());
}

export async function GET(req: Request) {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not set.' }, { status: 500 });
  }
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '');
  const queryToken = new URL(req.url).searchParams.get('token');
  if (!secretMatches(bearer, expected) && !secretMatches(queryToken, expected)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }

  const businessId = process.env.TRADEPILOT_BUSINESS_ID;
  if (!businessId) {
    return NextResponse.json({ ok: false, error: 'TRADEPILOT_BUSINESS_ID not set.' }, { status: 500 });
  }

  const todayISO = nzTodayISO();

  // ── 2. Anyone listening? ─────────────────────────────────────────────────
  const { count, error: countErr } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId);
  if (countErr) {
    return NextResponse.json({ ok: false, error: countErr.message }, { status: 500 });
  }
  if (!count) {
    return NextResponse.json({ ok: true, today: todayISO, subscriptions: 0, sent: 0 });
  }

  // ── 3. Load the world ────────────────────────────────────────────────────
  const [jobsRes, schedRes, billsRes, paysRes] = await Promise.all([
    supabaseAdmin.from('jobs').select('*').eq('business_id', businessId).in('status', ['lead', 'quoted']),
    supabaseAdmin.from('schedule_items').select('*').eq('business_id', businessId).eq('date', todayISO),
    supabaseAdmin
      .from('entries')
      .select('*')
      .eq('business_id', businessId)
      .eq('type', 'bill')
      .or(`is_draft.eq.true,and(paid.eq.false,due_date.not.is.null)`),
    supabaseAdmin.from('pay_runs').select('*').eq('business_id', businessId),
  ]);
  const loadErr = jobsRes.error ?? schedRes.error ?? billsRes.error ?? paysRes.error;
  if (loadErr) {
    return NextResponse.json({ ok: false, error: loadErr.message }, { status: 500 });
  }

  const candidates = evaluateNotificationRules({
    todayISO,
    jobs: (jobsRes.data ?? []).map(rowToJob),
    scheduleToday: (schedRes.data ?? []).map(rowToScheduleItem),
    bills: (billsRes.data ?? []).map(rowToEntry),
    payRuns: (paysRes.data ?? []).map(rowToPayRun),
  });

  // ── 4. Send (deduped, capped) ────────────────────────────────────────────
  let sent = 0;
  let pruned = 0;
  const results: Array<{ rule: string; key: string; outcome: string }> = [];
  for (const c of candidates) {
    if (sent >= MAX_SENDS_PER_RUN) {
      results.push({ rule: c.ruleKey, key: c.dedupeKey, outcome: 'deferred (cap)' });
      continue;
    }
    try {
      const r = await sendBusinessNotification(supabaseAdmin, businessId, c);
      pruned += r.pruned;
      if (r.sent > 0) sent++;
      results.push({
        rule: c.ruleKey,
        key: c.dedupeKey,
        outcome: r.sent > 0 ? `sent to ${r.sent} device(s)` : (r.skipped ?? 'no delivery'),
      });
    } catch (e) {
      // One bad candidate must not kill the run.
      console.error(`[cron/notifications] ${c.ruleKey}:${c.dedupeKey} failed:`, e);
      results.push({ rule: c.ruleKey, key: c.dedupeKey, outcome: 'error' });
    }
  }

  return NextResponse.json({
    ok: true,
    today: todayISO,
    subscriptions: count,
    candidates: candidates.length,
    sent,
    prunedSubscriptions: pruned,
    results,
  });
}
