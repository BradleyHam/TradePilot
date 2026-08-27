/**
 * Whose hours are these? — display-side attribution for `type: 'hours'`
 * entries.
 *
 * An hours entry carries two attribution fields (see `lib/types.ts`):
 *   - `loggedByUserId` — the auth user the hours belong to. Set when an
 *     employee logs their own time from /my/hours, and when Brad logs it
 *     on their behalf via the entry form's Who pills. This is what
 *     payroll pays from.
 *   - `workerKind` — the rate tier. 'owner' is Brad; any other tier with
 *     no `loggedByUserId` is a one-off helper who never reaches payroll.
 *
 * Without this, a day where Brad logged 6h for himself and 6h for Suzie
 * renders two identical "6h · stopping" rows. Any surface that lists
 * individual hours entries should say whose they are.
 */
import type { BusinessMember, Entry, ScheduleItem, WorkerKind } from '@/lib/types';

/**
 * Short badge labels. `WORKER_KIND_LABELS` in `lib/worker-rates.ts` is the
 * long form for pickers ("Helper / labourer"); these are for chips where
 * every character costs width on a phone.
 */
export const SHORT_WORKER_KIND_LABELS: Record<WorkerKind, string> = {
  owner:         'Me',
  experienced:   'Painter',
  apprentice:    'Apprentice',
  helper:        'Helper',
  subcontractor: 'Subbie',
};

/** "Suzie Hamilton" → "Suzie". Names are shown in tight chips. */
function firstName(name?: string): string {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed.split(/\s+/)[0] : '';
}

/**
 * Who did the work, as a short label for display.
 *
 * @param entry        the hours entry (only the two attribution fields are read)
 * @param teamMembers  every membership row for the business (`useStore().teamMembers`)
 * @param viewerUserId the signed-in user (`useStore().membership?.userId`) — their
 *                     own hours read as "Me" rather than their own name
 */
export function hoursWorkerLabel(
  entry: Pick<Entry, 'workerKind' | 'loggedByUserId' | 'workerName'>,
  teamMembers: BusinessMember[],
  viewerUserId?: string | null,
): string {
  // A typed-in name (subbie / one-off helper) beats every fallback — it's
  // the most specific thing anyone told us about this shift.
  const typed = (entry.workerName ?? '').trim();
  if (typed) return typed;
  const uid = entry.loggedByUserId;
  if (uid) {
    if (viewerUserId && uid === viewerUserId) return 'Me';
    const member = teamMembers.find((m) => m.userId === uid);
    const name = firstName(member?.displayName);
    if (name) return name;
    return member?.role === 'owner' ? 'Owner' : 'Team member';
  }
  const kind = entry.workerKind ?? 'owner';
  // Non-owner tier with no attribution = one-off helper. Say the tier, not
  // a name — there deliberately isn't one, and the tier is the honest
  // signal that these hours don't reach payroll.
  if (kind !== 'owner') return SHORT_WORKER_KIND_LABELS[kind];
  // Owner tier, no attribution — Brad's own entries (historic ones carry no
  // uid at all). "Me" when the viewer is the owner, which is the only case
  // that reaches the owner-side screens today.
  const owner = teamMembers.find((m) => m.role === 'owner');
  if (!owner || !viewerUserId || owner.userId === viewerUserId) return 'Me';
  return firstName(owner.displayName) || 'Owner';
}

/**
 * Group a day's (or period's) hours entries by who did the work, for a
 * "Me 6h · Suzie 6h" style subtotal line. Order follows first appearance
 * in `entries` so the list is stable as the user edits rows.
 */
export function hoursByWorker(
  entries: Pick<Entry, 'workerKind' | 'loggedByUserId' | 'workerName' | 'hours'>[],
  teamMembers: BusinessMember[],
  viewerUserId?: string | null,
): { label: string; hours: number }[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    const label = hoursWorkerLabel(e, teamMembers, viewerUserId);
    totals.set(label, (totals.get(label) ?? 0) + (e.hours ?? 0));
  }
  return [...totals.entries()].map(([label, hours]) => ({ label, hours }));
}

/**
 * Names of people with no login that Brad has used before — subbies and
 * one-off helpers, pulled from the hours he's logged and the bookings
 * he's crewed. Most recently used first, de-duplicated case-insensitively
 * (the first spelling seen wins).
 *
 * Point being: nobody should type "Kenneth" twice. There's no
 * subcontractor table to maintain — the names he's already typed ARE the
 * list.
 */
export function knownCrewNames(
  entries: Pick<Entry, 'type' | 'workerName' | 'entryDate'>[],
  scheduleItems: Pick<ScheduleItem, 'crewNames' | 'date'>[] = [],
): string[] {
  const dated: { name: string; date: string }[] = [];
  for (const e of entries) {
    if (e.type !== 'hours') continue;
    const n = (e.workerName ?? '').trim();
    if (n) dated.push({ name: n, date: e.entryDate });
  }
  for (const s of scheduleItems) {
    for (const raw of s.crewNames ?? []) {
      const n = raw.trim();
      if (n) dated.push({ name: n, date: s.date });
    }
  }
  dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const seen = new Map<string, string>();
  for (const d of dated) {
    const key = d.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, d.name);
  }
  return [...seen.values()];
}
