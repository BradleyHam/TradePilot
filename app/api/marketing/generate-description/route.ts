// DEPRECATED — superseded by /api/marketing/draft (full page copy) and the
// project preview's per-block /api/marketing/rewrite. Kept only because the
// file can't be removed from the sandbox; nothing in the app calls it.

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'Deprecated — use /api/marketing/draft.' },
    { status: 410 },
  );
}
