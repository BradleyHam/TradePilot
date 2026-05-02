'use client';

import { useEffect, useRef, useState } from 'react';
import { format, parseISO, startOfMonth, endOfMonth, subMonths, isSameMonth } from 'date-fns';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A simple {start, end} window — both inclusive ISO dates (YYYY-MM-DD).
 */
export interface Timeframe {
  start: string;
  end: string;
  /** Short label for the page subtitle, e.g. 'May 2026' or 'Feb–Apr 2026'. */
  label: string;
}

export type TimeframeKind = 'this-month' | 'last-month' | 'custom';

// ── Helpers ──────────────────────────────────────────────────────────────────
const iso = (d: Date) => format(d, 'yyyy-MM-dd');

function thisMonthFrame(now = new Date()): Timeframe {
  const start = startOfMonth(now);
  const end   = endOfMonth(now);
  return { start: iso(start), end: iso(end), label: format(start, 'MMMM yyyy') };
}

function lastMonthFrame(now = new Date()): Timeframe {
  const ref = subMonths(now, 1);
  const start = startOfMonth(ref);
  const end   = endOfMonth(ref);
  return { start: iso(start), end: iso(end), label: format(start, 'MMMM yyyy') };
}

/** Custom from→to, expressed in YYYY-MM (the value of <input type="month">). */
function customFrame(fromYm: string, toYm: string): Timeframe {
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  const start = startOfMonth(new Date(fy, (fm ?? 1) - 1, 1));
  const end   = endOfMonth(new Date(ty, (tm ?? 1) - 1, 1));
  const label = isSameMonth(start, end)
    ? format(start, 'MMMM yyyy')
    : `${format(start, 'MMM')} – ${format(end, 'MMM yyyy')}`;
  return { start: iso(start), end: iso(end), label };
}

/**
 * Decide the smart default. Returns this-month if any data falls in it;
 * otherwise last-month.
 */
export function smartDefault(entryDates: string[], now = new Date()): TimeframeKind {
  const tm = thisMonthFrame(now);
  const has = entryDates.some((d) => d >= tm.start && d <= tm.end);
  return has ? 'this-month' : 'last-month';
}

export function frameFor(
  kind: TimeframeKind,
  custom?: Timeframe | null,
  now = new Date(),
): Timeframe {
  if (kind === 'custom' && custom) return custom;
  if (kind === 'last-month') return lastMonthFrame(now);
  return thisMonthFrame(now);
}

// ── Component ────────────────────────────────────────────────────────────────
interface TimeframeSelectorProps {
  /** Currently selected kind. */
  kind: TimeframeKind;
  /** When kind === 'custom', this holds the active range. */
  custom: Timeframe | null;
  onChange: (kind: TimeframeKind, custom: Timeframe | null) => void;
}

export function TimeframeSelector({ kind, custom, onChange }: TimeframeSelectorProps) {
  const [showPicker, setShowPicker] = useState(false);
  // Picker draft state — separate from committed value so cancelling doesn't change anything.
  const [fromYm, setFromYm] = useState(() => format(subMonths(new Date(), 2), 'yyyy-MM'));
  const [toYm, setToYm]     = useState(() => format(new Date(), 'yyyy-MM'));
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close popover when clicking outside.
  useEffect(() => {
    if (!showPicker) return;
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showPicker]);

  function pick(k: 'this-month' | 'last-month') {
    setShowPicker(false);
    onChange(k, null);
  }

  function applyCustom() {
    const cf = customFrame(fromYm, toYm);
    // Guard: if from > to, swap them rather than blowing up.
    if (cf.start > cf.end) {
      const swapped = customFrame(toYm, fromYm);
      onChange('custom', swapped);
    } else {
      onChange('custom', cf);
    }
    setShowPicker(false);
  }

  const Chip = ({
    label, active, onClick,
  }: { label: string; active: boolean; onClick: () => void }) => (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 px-3 h-9 rounded-lg text-sm font-medium border transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="relative">
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        <Chip label="This month" active={kind === 'this-month'} onClick={() => pick('this-month')} />
        <Chip label="Last month" active={kind === 'last-month'} onClick={() => pick('last-month')} />
        <button
          onClick={() => setShowPicker((v) => !v)}
          className={cn(
            'shrink-0 px-3 h-9 rounded-lg text-sm font-medium border flex items-center gap-1 transition-colors',
            kind === 'custom'
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
          )}
        >
          {kind === 'custom' && custom ? custom.label : 'Other…'}
          <ChevronDown size={12} />
        </button>
      </div>

      {/* Popover */}
      {showPicker && (
        <div
          ref={popoverRef}
          className="absolute z-30 left-0 right-0 mt-2 bg-card border border-border rounded-2xl shadow-lg p-4 max-w-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-foreground">Pick months</p>
            <button
              onClick={() => setShowPicker(false)}
              className="p-1 rounded-md hover:bg-muted"
              aria-label="Close"
            >
              <X size={14} className="text-muted-foreground" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                From
              </label>
              <input
                type="month"
                value={fromYm}
                onChange={(e) => setFromYm(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                To
              </label>
              <input
                type="month"
                value={toYm}
                onChange={(e) => setToYm(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <button
            onClick={applyCustom}
            className="mt-3 w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-semibold"
          >
            Apply
          </button>
          <p className="mt-2 text-[10px] text-muted-foreground italic">
            Tip: pick the same month for both to view a single month.
          </p>
        </div>
      )}
    </div>
  );
}
