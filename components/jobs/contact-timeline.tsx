'use client';

/**
 * ContactTimeline — every conversation with this customer, newest first
 * (migration 042).
 *
 * Answers the question `lastContactedDate` never could: not "when did I last
 * chase?" but "what has actually passed between us?". On a quoted job that's
 * gone quiet, the shape of this list — three outbound in a row, nothing back —
 * is the argument for either one more call or writing it off.
 *
 * Owner-only, because the store only ever loads job_contacts for the owner
 * (RLS). Renders nothing when a job has no logged contacts, per the
 * no-empty-visualisations rule — which is also what a job created before
 * migration 042 looks like.
 *
 * Read-only by design. Rows are facts about what happened; editing them would
 * make the history negotiable, and the analysis is only worth having if the
 * data is what it says it is.
 */

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { CONTACT_CHANNEL_LABELS, type JobContact } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  MessageCircle, Phone, Mail, MessageSquare, MapPin, FileText,
  CornerDownLeft, ChevronDown,
} from 'lucide-react';

/** How many rows before the list collapses behind "Show all". */
const COLLAPSE_AFTER = 4;

const CHANNEL_ICON = {
  phone: Phone,
  email: Mail,
  text: MessageSquare,
  visit: MapPin,
  'quote-sent': FileText,
  other: MessageCircle,
  unknown: MessageCircle,
} as const;

/**
 * "Today" / "Yesterday" / "3 days ago" / a date once it's old enough that
 * counting days stops being useful. Relative wording is what makes a gap
 * legible at a glance — "14 days ago" reads as a problem in a way that
 * "22 Jul" doesn't.
 */
function relativeDay(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(then)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Days between this contact and the one before it (older). Rendered on
 * inbound rows only, where it means "they took this long to come back" —
 * the number the whole feature exists to make visible.
 */
function gapDays(row: JobContact, older: JobContact | undefined): number | null {
  if (!older) return null;
  const a = new Date(row.contactedAt).getTime();
  const b = new Date(older.contactedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = Math.round((a - b) / 86400000);
  return days < 0 ? null : days;
}

export function ContactTimeline({ jobId }: { jobId: string }) {
  const { jobContacts } = useStore();
  const [expanded, setExpanded] = useState(false);

  // Sort defensively rather than trusting load order: optimistic rows are
  // unshifted onto the front of the store array, so a backdated contact
  // logged via the quote catch-up would otherwise sit at the top until the
  // next refetch.
  const rows = useMemo(
    () => jobContacts
      .filter((c) => c.jobId === jobId)
      .slice()
      .sort((a, b) => b.contactedAt.localeCompare(a.contactedAt)),
    [jobContacts, jobId],
  );

  const now = useMemo(() => new Date(), []);

  if (rows.length === 0) return null;

  const shown = expanded ? rows : rows.slice(0, COLLAPSE_AFTER);
  const outCount = rows.filter((c) => c.direction === 'out').length;
  const inCount = rows.length - outCount;

  return (
    <div>
      {/* Own separator, because this whole panel disappears when a job has no
          logged contacts — a Separator left in the parent would render as a
          stray line above nothing. */}
      <div className="h-px bg-border -mx-0 mb-4" aria-hidden="true" />
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Contact history ({rows.length})
        </p>
        <p className="text-[11px] text-muted-foreground">
          {outCount} out{inCount > 0 && ` · ${inCount} back`}
        </p>
      </div>

      <div className="space-y-2">
        {shown.map((c, i) => {
          const inbound = c.direction === 'in';
          const Icon = inbound ? CornerDownLeft : (CHANNEL_ICON[c.channel] ?? MessageCircle);
          // `rows` is newest-first, so the previous contact is the NEXT index.
          const gap = inbound ? gapDays(c, rows[i + 1]) : null;
          return (
            <div key={c.id} className="flex items-start gap-3 p-3 rounded-xl bg-muted/40">
              <Icon
                size={15}
                className={cn('shrink-0 mt-0.5', inbound ? 'text-sky-600' : 'text-muted-foreground')}
                strokeWidth={1.8}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground">
                  {/* Fallback for the same reason the icon lookup has one:
                      042 leaves `channel` as free text with no check
                      constraint, so a row from an importer or manual SQL can
                      carry a value outside the union — which would render a
                      blank row title rather than a slightly generic one. */}
                  {inbound
                    ? 'They got back to me'
                    : (CONTACT_CHANNEL_LABELS[c.channel] ?? CONTACT_CHANNEL_LABELS.other)}
                  {gap !== null && gap > 0 && (
                    <span className="text-muted-foreground font-normal">
                      {' '}· after {gap} {gap === 1 ? 'day' : 'days'}
                    </span>
                  )}
                </p>
                {c.note && (
                  <p className="text-xs text-muted-foreground mt-0.5">{c.note}</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground shrink-0 mt-0.5">
                {relativeDay(c.contactedAt, now)}
              </p>
            </div>
          );
        })}
      </div>

      {rows.length > COLLAPSE_AFTER && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 min-h-[36px] w-full inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} />
          {expanded ? 'Show less' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
