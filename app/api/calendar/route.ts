// GET /api/calendar?token=<CALENDAR_FEED_SECRET>
//
// A read-only iCalendar (.ics) FEED of the business's job bookings, meant to
// be *subscribed to* from Apple Calendar / Google Calendar. Subscribe once on
// the Mac (or iPhone) and the calendar app re-fetches on its own schedule; via
// iCloud the same subscription shows on every Apple device.
//
// Why a token in the query string (not a header)?
//   Calendar clients fetch a subscription URL with a plain GET and can't send
//   custom headers, so the shared secret rides in the URL. Keep the URL
//   private — anyone with it can read the feed. Only job bookings are exposed;
//   no money, no client contact details, no other schedule types.
//
// Why the service-role client?
//   A subscription fetch has no auth.uid(), and RLS on schedule_items requires
//   owner-of-business = auth.uid(). Same pattern as the inbound webhooks:
//   authenticate with our own secret, then read with the service-role key
//   scoped to TRADEPILOT_BUSINESS_ID.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { buildIcsFeed, type IcsFeedEvent } from '@/lib/ics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Only surface bookings from this far back — keeps the feed lean while still
// showing recent history. Future bookings are always included.
const LOOKBACK_DAYS = 120;

function getAdminClient(): SupabaseClient | { error: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return { error: 'Server misconfigured: Supabase env vars missing.' };
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface ScheduleRow {
  id: string;
  title: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  jobs: { location: string | null } | { location: string | null }[] | null;
}

function jobLocation(row: ScheduleRow): string | undefined {
  const j = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
  const loc = j?.location?.trim();
  return loc && loc.length > 0 ? loc : undefined;
}

export async function GET(req: Request) {
  // ── 1. Authenticate via shared secret in the query string ───────────────
  const expectedSecret = process.env.CALENDAR_FEED_SECRET;
  if (!expectedSecret) {
    return new Response('Server misconfigured: CALENDAR_FEED_SECRET not set.', {
      status: 500,
    });
  }
  const token = new URL(req.url).searchParams.get('token');
  if (!token || token !== expectedSecret) {
    return new Response('Invalid or missing feed token.', { status: 401 });
  }

  // ── 2. Resolve business id + admin client ───────────────────────────────
  const businessId = process.env.TRADEPILOT_BUSINESS_ID;
  if (!businessId) {
    return new Response('Server misconfigured: TRADEPILOT_BUSINESS_ID not set.', {
      status: 500,
    });
  }
  const adminOrErr = getAdminClient();
  if ('error' in adminOrErr) {
    return new Response(adminOrErr.error, { status: 500 });
  }
  const admin = adminOrErr;

  // ── 3. Read job bookings (money-free by nature) ─────────────────────────
  const lookback = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await admin
    .from('schedule_items')
    .select('id, title, date, start_time, end_time, notes, jobs(location)')
    .eq('business_id', businessId)
    .eq('type', 'job_booking')
    .gte('date', lookback)
    .order('date', { ascending: true });

  if (error) {
    console.error('[calendar-feed] query failed', error);
    return new Response('Failed to load calendar.', { status: 500 });
  }

  const rows = (data ?? []) as unknown as ScheduleRow[];
  const events: IcsFeedEvent[] = rows.map((r) => ({
    uid: `${r.id}@tradepilot`,
    summary: r.title?.trim() || 'Job booking',
    date: r.date,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    location: jobLocation(r),
    description: r.notes?.trim() || undefined,
  }));

  const body = buildIcsFeed(events, { calendarName: 'TradePilot — Job bookings' });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="tradepilot.ics"',
      // Let clients cache briefly; they'll re-fetch on their own cadence.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
