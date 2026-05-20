// GET /api/public/availability
//
// Public read-only endpoint that returns Brad's current and upcoming
// schedule availability, computed from real schedule_items + jobs in
// Supabase. Designed to be fetched by the painterswanaka.co.nz site
// (and any other consumer) to render a "next available" banner.
//
// Why public, no auth:
//   The data leaked here is just "Brad is/isn't free, here are some
//   dates" — which Brad would tell any prospective client over the
//   phone anyway. No financials, no client names beyond the booking's
//   job name (which is typically the address — e.g. "84C Aubrey Road").
//   If that ever becomes a privacy concern, jobName can be stripped.
//
// Why service role:
//   No auth.uid() for an unauthenticated caller; RLS on jobs +
//   schedule_items would block reads. Service role bypasses RLS. The
//   TRADEPILOT_BUSINESS_ID env var pins WHICH business we expose —
//   even if this app later hosts multiple businesses, the public
//   endpoint only ever talks about the one whose ID is set.
//
// Caching:
//   Cache-Control: public, s-maxage=300, stale-while-revalidate=600
//   - 5min CDN cache: rendering pages on the website doesn't hammer
//     the DB. Sub-5min staleness is fine for an availability banner.
//   - 10min stale-while-revalidate: if you take a booking right now,
//     the banner can be stale for up to 15min total before reflecting
//     it. Acceptable trade-off for not hitting the DB every render.
//
// CORS:
//   We allow * for now — this is a read-only public endpoint and the
//   data was always going to be on the public web anyway. If we
//   tighten later (e.g. rate-limit by referrer), * stays the default
//   and we narrow on a case-by-case basis.

import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { computeAvailability } from '@/lib/availability';
import type { Job, ScheduleItem } from '@/lib/types';

// Always evaluate dynamically — schedule changes throughout the day,
// and even though we cache via Cache-Control, route handlers default
// to static rendering at build time which would freeze the response
// to whatever was true at deploy time.
export const dynamic = 'force-dynamic';

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

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET() {
  const businessId = process.env.TRADEPILOT_BUSINESS_ID;
  if (!businessId) {
    return NextResponse.json(
      { ok: false, error: 'Server misconfigured: TRADEPILOT_BUSINESS_ID not set.' },
      { status: 500, headers: corsHeaders() },
    );
  }

  const clientOrErr = getAdminClient();
  if ('error' in clientOrErr) {
    return NextResponse.json(
      { ok: false, error: clientOrErr.error },
      { status: 500, headers: corsHeaders() },
    );
  }
  const sb = clientOrErr;

  const today = todayISO();
  // Lookahead window — match the helper's 180-day horizon, plus a
  // small overlap to avoid edge-of-window weirdness in the date math.
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 200);
  const horizonISO = horizon.toISOString().slice(0, 10);

  // ── Pull schedule_items in the window ───────────────────────────────────
  const { data: scheduleRows, error: schedErr } = await sb
    .from('schedule_items')
    .select('id, business_id, job_id, type, title, date, start_time, end_time, notes, completed, created_at')
    .eq('business_id', businessId)
    .gte('date', today)
    .lte('date', horizonISO);
  if (schedErr) {
    console.error('[availability] schedule_items query failed:', schedErr);
    return NextResponse.json(
      { ok: false, error: 'Failed to load schedule.' },
      { status: 500, headers: corsHeaders() },
    );
  }

  // ── Pull jobs (just the ones referenced by those schedule items) ────────
  const jobIds = Array.from(
    new Set((scheduleRows ?? []).map((r) => r.job_id).filter((id): id is string => !!id)),
  );
  let jobRows: { id: string; name: string; client_name: string | null; status: string }[] = [];
  if (jobIds.length > 0) {
    const { data, error: jobErr } = await sb
      .from('jobs')
      .select('id, name, client_name, status')
      .in('id', jobIds);
    if (jobErr) {
      console.error('[availability] jobs query failed:', jobErr);
      return NextResponse.json(
        { ok: false, error: 'Failed to load jobs.' },
        { status: 500, headers: corsHeaders() },
      );
    }
    jobRows = data ?? [];
  }

  // ── Shape into the helper's expected types ──────────────────────────────
  const scheduleItems: ScheduleItem[] = (scheduleRows ?? []).map((r) => ({
    id: r.id,
    businessId: r.business_id,
    jobId: r.job_id ?? undefined,
    type: r.type,
    title: r.title,
    date: r.date,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    notes: r.notes ?? undefined,
    completed: !!r.completed,
    createdAt: r.created_at,
  }));

  const jobs: Job[] = jobRows.map((r) => ({
    id: r.id,
    businessId,
    name: r.name,
    clientName: r.client_name ?? '',
    status: r.status as Job['status'],
    createdAt: today,  // not used by the helper
    updatedAt: today,  // not used by the helper
  }));

  const report = computeAvailability(scheduleItems, jobs, today);

  return NextResponse.json(
    { ok: true, ...report },
    { status: 200, headers: corsHeaders() },
  );
}
