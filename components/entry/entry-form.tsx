'use client';

import { useState } from 'react';
import { EntryType, Entry, ExpenseCategory, ActivityType, LeadSource, WorkerKind, BusinessMember } from '@/lib/types';
import { EXPENSE_CATEGORIES, ACTIVITY_TYPES } from '@/lib/mock-data';
import { WORKER_KIND_LABELS } from '@/lib/worker-rates';
import { useStore } from '@/lib/store';
import { lastCostRateFor } from '@/lib/labour-accrual';
import { JobPicker } from '@/components/shared/job-picker';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface EntryFormProps {
  defaultType?: EntryType;
  /**
   * Lock the form to `defaultType` (or the edited row's type) and hide the
   * entry-type pill row entirely. Used by callers that are explicitly an
   * hours flow (e.g. the schedule's "Log hours") where offering Expense /
   * Income / Quote etc. is just noise.
   */
  lockType?: boolean;
  /**
   * If provided, the form starts in "edit" mode: fields are prefilled, save
   * button reads "Update", and an `onDelete` button (if supplied) is shown.
   */
  defaultValues?: Partial<Entry>;
  /** Label override for the primary action button. Default: "Save Entry". */
  submitLabel?: string;
  /**
   * If supplied, a Delete button appears next to Cancel/Save. Caller is
   * responsible for confirming the deletion (this form just calls it).
   */
  onDelete?: () => void;
  onSave: (entry: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) => void;
  /**
   * Create an ADDITIONAL entry, on top of the one `onSave` handles.
   *
   * Only used by hours edit sheets. An hours row is one person's shift, so
   * tagging a second person on an existing row can't be done by editing that
   * row — the extra people need rows of their own. Supply this and the Who
   * pills go multi-select in edit mode: the first person picked updates the
   * row being edited (via `onSave`), everyone else comes through here as a
   * new entry with the same date / job / activity / hours.
   *
   * Leave it out and edit mode stays single-select (tapping a pill swaps
   * who the row belongs to), which is the right behaviour for callers that
   * can only write back to one id.
   */
  onSaveAdditional?: (entry: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) => void;
  onCancel: () => void;
}

const ENTRY_TYPES: { value: EntryType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'hours', label: 'Hours' },
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'quote', label: 'Quote' },
  { value: 'bill', label: 'Bill Due' },
  { value: 'note', label: 'Note' },
];

const OVERHEAD_PREFIX = '[OH] ';

// Split `total` hours across `n` activities in half-hour steps, spreading
// any remainder half-hours across the first rows: 6h/3 → [2,2,2];
// 7h/2 → [3.5,3.5]; 5h/3 → [2,1.5,1.5]. Integer maths on half-hour units
// so we never emit 1.9999.
function evenSplit(total: number, n: number): number[] {
  if (n <= 0 || !isFinite(total) || total <= 0) return Array(Math.max(n, 0)).fill(0);
  const halves = Math.round(total * 2);
  const base = Math.floor(halves / n);
  const rem = halves - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < rem ? 1 : 0)) / 2);
}

// The "Who" quick-select: Brad, each employee by name, or a one-off
// "someone else" (tier picker, not on payroll). Stored as 'me' | 'other' |
// a BusinessMember id.
type WhoSel = 'me' | 'other' | string;

// Lead source chip options for the enquiry form. Ordered roughly by how
// often Brad gets leads from each channel — most-common first so the chip
// he wants is usually one tap. GMB attribution is fuzzy in practice (people
// who find him on Google still call rather than click) but worth tracking
// to spot the rough trend.
const LEAD_SOURCE_OPTIONS: { value: LeadSource; label: string }[] = [
  { value: 'referral', label: 'Referral' },
  { value: 'website',  label: 'Website' },
  { value: 'gmb',      label: 'Google' },
  { value: 'phone',    label: 'Phone' },
  { value: 'email',    label: 'Email' },
  { value: 'manual',   label: 'Other' },
];

export function EntryForm({
  defaultType = 'expense',
  lockType = false,
  defaultValues,
  submitLabel,
  onDelete,
  onSave,
  onSaveAdditional,
  onCancel,
}: EntryFormProps) {
  const { jobs, entries, teamMembers } = useStore();
  const today = new Date().toISOString().split('T')[0];

  // Editing an existing row (has an id) vs creating. Some create flows pass
  // partial defaultValues (e.g. schedule pre-fills entryDate), so presence of
  // defaultValues alone doesn't mean edit.
  const isEdit = Boolean(defaultValues?.id);
  // Can this form fan a save out into more than one row? Always true when
  // creating. On edit it needs `onSaveAdditional` — without it there is
  // nowhere for a second person's entry to go, so the pills stay
  // single-select rather than promising something the caller can't do.
  const canFanOut = !isEdit || Boolean(onSaveAdditional);
  // Employees get "log on their behalf" pills. Payroll pays from rows
  // attributed via loggedByUserId, so a pill-tap here genuinely reaches
  // their timesheet — see handleSave.
  const employeeMembers = teamMembers.filter((m) => m.role === 'employee');

  // When prefilling from an existing entry, strip the `[OH]` prefix so the
  // user sees the raw description and the Overhead toggle reflects the flag
  // separately. Re-added on save in the same flow.
  const seededDescription = (() => {
    const desc = defaultValues?.description ?? '';
    return desc.startsWith(OVERHEAD_PREFIX) ? desc.slice(OVERHEAD_PREFIX.length) : desc;
  })();
  const seededIsOverhead = (defaultValues?.description ?? '').startsWith(OVERHEAD_PREFIX);

  const [type, setType] = useState<EntryType>(defaultValues?.type ?? defaultType);
  const [description, setDescription] = useState(seededDescription);
  const [amount, setAmount] = useState(defaultValues?.amount?.toString() ?? '');
  const [hours, setHours] = useState(defaultValues?.hours?.toString() ?? '');
  const [category, setCategory] = useState<ExpenseCategory | ''>(defaultValues?.category ?? '');
  // Activities are multi-select in create mode: pick 2+ and the total gets
  // split into one entry per activity (see the split UI below). Edit mode is
  // single-select — an existing row IS one entry, we can't fan it out.
  const [activities, setActivities] = useState<ActivityType[]>(
    defaultValues?.activity ? [defaultValues.activity] : [],
  );
  // Per-activity hours (as strings, forgiving input) when 2+ activities are
  // selected. Keyed by activity. Rebuilt on selection/total change.
  const [splitHours, setSplitHours] = useState<Record<string, string>>({});
  // Who did the work — 'me' (Brad), employee member ids (logged on their
  // behalf, reaches payroll), or 'other' (one-off helper tier, not on
  // payroll). MULTI-select: pick everyone who was on site and each person
  // gets their own entry with the full hours (two people on an 8h day both
  // worked 8h). On edit, multi-select needs `onSaveAdditional` — the row
  // being edited is one person's, and the extras become new rows beside it.
  // Seeded from the row being edited: an attributed row maps back to its
  // member pill; an unattributed non-owner tier → 'other'.
  const [whoSels, setWhoSels] = useState<WhoSel[]>(() => {
    const lb = defaultValues?.loggedByUserId;
    if (lb) {
      const m = teamMembers.find((t) => t.userId === lb);
      return [m && m.role === 'employee' ? m.id : 'me'];
    }
    return [(defaultValues?.workerKind ?? 'owner') === 'owner' ? 'me' : 'other'];
  });
  const whoSel = whoSels[0] ?? 'me'; // representative, used by edit-mode paths
  // Worker tier for the 'other' path — defaults to 'helper' (the common
  // one-off case). Preserves whatever was saved when editing.
  const [workerKind, setWorkerKind] = useState<WorkerKind>(
    (defaultValues?.workerKind && defaultValues.workerKind !== 'owner')
      ? defaultValues.workerKind
      : 'helper',
  );
  // Name for the 'other' path — the subbie or one-off helper who has no
  // login to attribute to. Optional; without it the row can only ever say
  // "Subcontractor", which is no help months later.
  const [workerName, setWorkerName] = useState(defaultValues?.workerName ?? '');
  // What this person costs per hour, ex-GST. Drives the unbilled-labour
  // accrual (lib/labour-accrual.ts) — leave it blank and the hours cost
  // the job nothing, which is the honest answer when Brad doesn't know
  // the rate yet.
  const [costRate, setCostRate] = useState(
    defaultValues?.workerCostRate ? String(defaultValues.workerCostRate) : '',
  );
  // Once he's typed in the rate box we stop auto-filling it from history,
  // so a remembered rate can never overwrite what he just entered.
  const [rateTouched, setRateTouched] = useState(Boolean(defaultValues?.workerCostRate));
  // Has the worker actually invoiced these hours? Ticking it retires the
  // accrual so their bill is the only thing counting. Normally set by the
  // prompt when confirming that bill; this is the manual fallback.
  const [labourBilled, setLabourBilled] = useState(Boolean(defaultValues?.labourBilled));

  /** Pre-fill the rate with what this person was last paid, unless Brad
   *  has already typed one. Called from the name + tier controls rather
   *  than an effect (the repo lints against setState inside effects). */
  function autoFillRate(name: string, kind: WorkerKind) {
    if (rateTouched) return;
    const remembered = lastCostRateFor(entries, name, kind);
    setCostRate(remembered ? String(remembered) : '');
  }
  // What this person was last paid — shown as the placeholder so the box
  // reads as "same as last time?" rather than empty.
  const rememberedRate = lastCostRateFor(entries, workerName, workerKind);
  // Live "so what does this shift cost me" hint. Rounded — it's a sanity
  // check next to the box, not an invoice.
  const parsedRate = parseFloat(costRate);
  const parsedHours = parseFloat(hours);
  const costHint = (parsedRate > 0 && parsedHours > 0)
    ? `= $${Math.round(parsedRate * parsedHours).toLocaleString('en-NZ')} for ${parsedHours}h`
    : undefined;
  const [jobId, setJobId] = useState(defaultValues?.jobId ?? '');
  // Overhead = no job, deliberately. Distinct from "I forgot to pick one".
  // Stored as `[OH]` description prefix; jobId stays null.
  const [isOverhead, setIsOverhead] = useState(seededIsOverhead);
  // Lead source — only surfaced for enquiry-type entries. Stored on the
  // entry row (lead_source column) so we can later report on "where do my
  // leads come from?" without needing a job to exist yet.
  const [leadSource, setLeadSource] = useState<LeadSource | ''>(defaultValues?.leadSource ?? '');
  const [supplier, setSupplier] = useState(defaultValues?.supplier ?? '');
  const [dueDate, setDueDate] = useState(defaultValues?.dueDate ?? '');
  // Entry date — defaults to today but editable so the user can backdate
  // hours, expenses etc. Critical for the hours-by-month allocation.
  const [entryDate, setEntryDate] = useState(defaultValues?.entryDate ?? today);

  // Bill-specific edit fields. Hidden from the create flow, but surfaced when
  // editing so a user can fix paid status / payment ref on a bill entry.
  const [paid, setPaid] = useState(defaultValues?.paid ?? false);
  const [paidDate, setPaidDate] = useState(defaultValues?.paidDate ?? '');
  const [paymentRef, setPaymentRef] = useState(defaultValues?.paymentRef ?? '');
  const [company, setCompany] = useState(defaultValues?.company ?? '');

  // Resolve the Who selection into the two fields the entry carries.
  // - 'me'      → owner tier. Preserves an existing self-attribution when
  //               editing (Brad's own /my/hours rows carry his uid).
  // - member id → that member's tier + loggedByUserId = their auth uid, so
  //               payroll picks the hours up exactly as if they'd logged it
  //               from their own login.
  // - 'other'   → picked tier, NO attribution (one-off helpers aren't on
  //               payroll). Editing away a member attribution clears it.
  /** '' clears a name the row used to carry; undefined leaves the column
   *  alone entirely (so a save never writes worker_name unless a name is
   *  actually in play). */
  const clearNameIfAny = defaultValues?.workerName ? '' : undefined;
  /** 0 clears a rate the row used to carry (0 accrues nothing); undefined
   *  leaves the column untouched. */
  const clearRateIfAny = defaultValues?.workerCostRate ? 0 : undefined;
  const clearBilledIfAny = defaultValues?.labourBilled ? false : undefined;

  /** Which Who pill an existing hours row belongs to. Mirrors the seeding
   *  logic for `whoSels` — same row in, same pill out. */
  function selForEntry(e: Entry): WhoSel {
    if (e.loggedByUserId) {
      const m = teamMembers.find((t) => t.userId === e.loggedByUserId);
      return m && m.role === 'employee' ? m.id : 'me';
    }
    return (e.workerKind ?? 'owner') === 'owner' ? 'me' : 'other';
  }

  /**
   * Who already has hours on this job + day, other than the row being
   * edited. Tagging a second person creates a row for them, and that row is
   * NOT visible the next time this entry is opened — so without this guard,
   * re-tapping Suzie on a later edit would quietly log her hours twice.
   * Double-counted hours move payroll and the job's cost, so the pills say
   * she's already on, and the save skips her.
   */
  const siblingSels: Set<WhoSel> = new Set(
    type === 'hours' && isEdit
      ? entries
          .filter((e) => e.type === 'hours'
            && e.id !== defaultValues?.id
            && e.entryDate === (entryDate || today)
            && (e.jobId ?? '') === (jobId || ''))
          .map(selForEntry)
      : [],
  );

  function resolveWho(sel: WhoSel = whoSel): {
    workerKind: WorkerKind;
    loggedByUserId?: string;
    workerName?: string;
    workerCostRate?: number;
    labourBilled?: boolean;
  } {
    if (sel === 'me') {
      const orig = defaultValues?.loggedByUserId;
      const origIsSelf = orig && teamMembers.find((m) => m.userId === orig)?.role !== 'employee';
      return {
        workerKind: 'owner',
        // '' clears the column on edit; undefined leaves it unset on create.
        loggedByUserId: origIsSelf ? orig : (isEdit ? '' : undefined),
        workerName: clearNameIfAny,
        // Brad's own time isn't a cost to the job — it's what the job pays
        // him. Never accrues.
        workerCostRate: clearRateIfAny,
        labourBilled: clearBilledIfAny,
      };
    }
    if (sel === 'other') {
      const rate = parseFloat(costRate);
      const priced = Number.isFinite(rate) && rate > 0;
      return {
        workerKind,
        loggedByUserId: isEdit ? '' : undefined,
        workerName: workerName.trim() || clearNameIfAny,
        workerCostRate: priced ? rate : clearRateIfAny,
        labourBilled: priced ? labourBilled : clearBilledIfAny,
      };
    }
    const member = employeeMembers.find((m) => m.id === sel);
    if (!member) {
      return {
        workerKind: 'owner',
        loggedByUserId: isEdit ? '' : undefined,
        workerName: clearNameIfAny,
        workerCostRate: clearRateIfAny,
        labourBilled: clearBilledIfAny,
      };
    }
    // A team member has their own name — a typed-in one would only ever
    // contradict it. No cost rate either: staff are paid through pay runs,
    // and accruing them here would double-count the wages.
    return {
      workerKind: member.workerKind ?? 'helper',
      loggedByUserId: member.userId,
      workerName: clearNameIfAny,
      workerCostRate: clearRateIfAny,
      labourBilled: clearBilledIfAny,
    };
  }

  /** Toggle a Who pill. Toggles membership but never empties the set —
   *  hours always belong to somebody, and a save with nobody picked would
   *  silently drop attribution. When the caller can't take extra rows
   *  (`canFanOut` false) a tap replaces instead, so edit stays a swap. */
  function toggleWho(key: WhoSel) {
    if (!canFanOut) {
      setWhoSels([key]);
      return;
    }
    setWhoSels((prev) => {
      if (prev.includes(key)) {
        const next = prev.filter((k) => k !== key);
        return next.length > 0 ? next : prev;
      }
      return [...prev, key];
    });
  }

  function handleSave() {
    if (!description.trim()) return;

    // Multi-activity and/or multi-person hours (create mode only): one entry
    // per PERSON per ACTIVITY. Same description/date/job on every row — the
    // person, activity and hours are the only things that differ. Everyone
    // picked gets the full hours (two people on an 8h day both worked 8h);
    // the activity split, when present, applies to each person alike.
    if (type === 'hours' && !isEdit && (activities.length > 1 || whoSels.length > 1)) {
      let slices: { activity: ActivityType | undefined; hours: number | undefined }[];
      if (activities.length > 1) {
        slices = activities
          .map((a) => ({ activity: a as ActivityType | undefined, hours: parseFloat(splitHours[a] ?? '') }))
          .filter((s) => isFinite(s.hours!) && s.hours! > 0);
      } else {
        slices = [{
          activity: activities[0] || undefined,
          hours: hours ? parseFloat(hours) : undefined,
        }];
      }
      if (slices.length === 0) return;
      for (const sel of whoSels) {
        const who = resolveWho(sel);
        for (const s of slices) {
          onSave({
            jobId: jobId || undefined,
            type,
            hours: s.hours,
            activity: s.activity,
            gstApplies: false,
            description: description.trim(),
            entryDate: entryDate || today,
            workerKind: who.workerKind,
            loggedByUserId: who.loggedByUserId,
            workerName: who.workerName,
            workerCostRate: who.workerCostRate,
            labourBilled: who.labourBilled,
          });
        }
      }
      return;
    }

    const who = type === 'hours' ? resolveWho() : undefined;
    // Editing an hours row and more than one person is now tagged: the row
    // itself becomes the first person's (below), and everyone else needs a
    // row of their own. Same date, job, activity, description and hours —
    // two people on a 6.5h day each worked 6.5h, same rule as create mode.
    const extraWhoSels = type === 'hours' && isEdit && onSaveAdditional
      ? whoSels.slice(1)
      : [];
    onSave({
      jobId: jobId || undefined,
      type,
      category: (category as ExpenseCategory) || undefined,
      amount: amount ? parseFloat(amount) : undefined,
      hours: hours ? parseFloat(hours) : undefined,
      activity: activities[0] || undefined,
      supplier: supplier || undefined,
      gstApplies: type === 'expense' || type === 'income' || type === 'bill',
      // Tag overheads in the description so they're greppable later. Only
      // money-out types (expense, bill) can be overhead — guard here so a
      // lingering `isOverhead = true` from a previous type can't leak the
      // `[OH]` prefix onto a non-money entry (hours, note, etc.).
      description: (isOverhead && (type === 'expense' || type === 'bill') ? OVERHEAD_PREFIX : '') + description.trim(),
      entryDate: entryDate || today,
      dueDate: dueDate || undefined,
      // Bill-specific — preserved on edit, harmless on create (the save flow
      // ignores these unless type === 'bill' downstream).
      paid: type === 'bill' ? paid : undefined,
      paidDate: type === 'bill' && paid ? (paidDate || undefined) : undefined,
      paymentRef: type === 'bill' ? (paymentRef || undefined) : undefined,
      company: type === 'bill' ? (company || undefined) : undefined,
      // Only attach lead source for enquiries — the picker is hidden for
      // other types so the state could be stale from a prior chip flip.
      leadSource: type === 'enquiry' ? (leadSource || undefined) : undefined,
      // Who did the work — only meaningful for hours-type entries. The
      // picker is hidden for other types so stale state from a chip flip
      // doesn't leak through.
      workerKind: who?.workerKind,
      loggedByUserId: who?.loggedByUserId,
      workerName: who?.workerName,
      workerCostRate: who?.workerCostRate,
      labourBilled: who?.labourBilled,
    });

    // The extra people, as new rows. Deliberately after the primary save:
    // if anything here fails, the edit the user actually made is already in.
    for (const sel of extraWhoSels) {
      // They already have hours on this job + day — see `siblingSels`.
      if (siblingSels.has(sel)) continue;
      const extra = resolveWho(sel);
      onSaveAdditional!({
        jobId: jobId || undefined,
        type: 'hours',
        hours: hours ? parseFloat(hours) : undefined,
        activity: activities[0] || undefined,
        gstApplies: false,
        description: description.trim(),
        entryDate: entryDate || today,
        workerKind: extra.workerKind,
        // `resolveWho` returns ''/0 to CLEAR a column on the row being
        // edited. A new row has nothing to clear, so those become undefined
        // — an unset rate reads as "rate unknown" downstream, where 0 would
        // read as "this person cost the job nothing".
        loggedByUserId: extra.loggedByUserId || undefined,
        workerName: extra.workerName || undefined,
        workerCostRate: extra.workerCostRate || undefined,
        labourBilled: extra.labourBilled || undefined,
      });
    }
  }

  return (
    <div className="space-y-3">
      {/* Type selector — hidden entirely when the caller locked the type
          (e.g. the schedule's "Log hours", which is only ever hours). */}
      {!lockType && (
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Entry type
        </label>
        <div className="flex flex-wrap gap-2">
          {ENTRY_TYPES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setType(value)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                type === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Lead source — enquiry only. Tap-no-type, optional. Sits between
          Entry type and Description because "Enquiry → where from?" is the
          natural next question and Brad will usually know the answer
          before he's typed the client's name. */}
      {type === 'enquiry' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Lead source (optional)
          </label>
          <div className="flex flex-wrap gap-2">
            {LEAD_SOURCE_OPTIONS.map(({ value, label }) => {
              const selected = leadSource === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setLeadSource(selected ? '' : value)}
                  className={cn(
                    'px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[44px]',
                    selected
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Description */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Description
        </label>
        <Textarea
          placeholder={
            type === 'expense' ? 'e.g. Paint and supplies from Resene'
            : type === 'income' ? 'e.g. Payment received from Johnson'
            : type === 'hours' ? 'e.g. Painting second coat bedrooms'
            : type === 'enquiry' ? 'e.g. Sarah Thompson - interior repaint Wanaka'
            : type === 'quote' ? 'e.g. Quote sent to McLeod for cedar restain'
            : type === 'bill' ? 'e.g. Power bill due'
            : 'Add a note...'
          }
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="resize-none text-sm"
          rows={2}
        />
      </div>

      {/* Entry date — editable so hours/expenses can be backdated. */}
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Date {entryDate !== today && (
            <span className="ml-1 text-amber-600 normal-case">· backdated</span>
          )}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            className="flex-1 h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {entryDate !== today && (
            <button
              type="button"
              onClick={() => setEntryDate(today)}
              className="text-xs text-muted-foreground hover:text-foreground px-2 h-9 rounded-md hover:bg-muted"
            >
              Today
            </button>
          )}
        </div>
      </div>

      {/* Amount / Hours */}
      <div className="grid grid-cols-2 gap-3">
        {(type === 'expense' || type === 'income' || type === 'quote' || type === 'bill') && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Amount ($)
            </label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        )}
        {type === 'hours' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              {activities.length > 1 ? 'Total hours' : 'Hours'}
            </label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0"
              step="0.5"
              value={hours}
              onChange={(e) => {
                setHours(e.target.value);
                // Editing the total re-splits evenly across the selected
                // activities — the total is the source of truth here; the
                // per-activity rows below are for fine-tuning after.
                if (activities.length > 1) {
                  const parts = evenSplit(parseFloat(e.target.value), activities.length);
                  setSplitHours(Object.fromEntries(
                    activities.map((a, i) => [a, parts[i] ? String(parts[i]) : '']),
                  ));
                }
              }}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        )}

        {/* Category */}
        {type === 'expense' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Category
            </label>
            <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

      </div>

      {/* Activity — tap pills, multi-select in create mode. Picking 2+
          splits the total into one entry per activity: even split by
          default (half-hour steps), fine-tune per row below. Edit mode is
          single-select because an existing row is one entry. */}
      {type === 'hours' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Activity{isEdit ? '' : ' — tap all that apply'}
          </label>
          <div className="flex flex-wrap gap-2">
            {ACTIVITY_TYPES.map((a) => {
              const selected = activities.includes(a);
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => {
                    const next = isEdit
                      ? (selected ? [] : [a])
                      : (selected ? activities.filter((x) => x !== a) : [...activities, a]);
                    setActivities(next);
                    if (next.length > 1) {
                      const parts = evenSplit(parseFloat(hours), next.length);
                      setSplitHours(Object.fromEntries(
                        next.map((x, i) => [x, parts[i] ? String(parts[i]) : '']),
                      ));
                    }
                  }}
                  className={cn(
                    'px-3 py-2 rounded-lg text-sm font-medium border capitalize transition-colors min-h-[44px]',
                    selected
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground',
                  )}
                >
                  {a}
                </button>
              );
            })}
          </div>

          {/* The split — one row per selected activity. Adjusting a row
              updates the total (the rows are the truth once you're
              hand-tuning); editing the total up top re-splits evenly. */}
          {activities.length > 1 && (
            <div className="mt-2 space-y-1.5">
              {activities.map((a) => (
                <div key={a} className="flex items-center gap-2">
                  <span className="flex-1 text-sm capitalize text-foreground">{a}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.5"
                    min="0"
                    value={splitHours[a] ?? ''}
                    onChange={(e) => {
                      const next = { ...splitHours, [a]: e.target.value };
                      setSplitHours(next);
                      const sum = activities.reduce(
                        (s, x) => s + (parseFloat(next[x] ?? '') || 0), 0);
                      setHours(sum > 0 ? String(Math.round(sum * 100) / 100) : '');
                    }}
                    className="w-20 h-11 px-3 rounded-lg border border-input bg-background text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-sm text-muted-foreground w-4">h</span>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground leading-snug">
                Saves as {activities.length} entries — one per activity.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Who did the work — quick-select pills. "Me" (Brad), one pill per
          employee (logs on their behalf WITH loggedByUserId, so payroll
          picks it up exactly like a /my/hours row — the old "logged here
          never reaches payroll" trap is gone for the pills), and "Someone
          else" for one-off helpers, which reveals the tier picker and
          keeps the payroll warning. */}
      {type === 'hours' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Who{canFanOut ? ' — tap all that apply' : ''}
          </label>
          <div className="flex flex-wrap gap-2">
            {([
              { key: 'me' as WhoSel, label: 'Me' },
              ...employeeMembers.map((m: BusinessMember) => ({
                key: m.id as WhoSel,
                label: m.displayName || 'Team member',
              })),
              { key: 'other' as WhoSel, label: 'Someone else' },
            ]).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleWho(key)}
                aria-pressed={whoSels.includes(key)}
                className={cn(
                  'px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[44px]',
                  whoSels.includes(key)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : siblingSels.has(key)
                      // Already has their own hours on this job + day. Shown
                      // as on-site-but-elsewhere so it doesn't read as
                      // "nobody logged them".
                      ? 'bg-primary/10 text-foreground border-primary/40'
                      : 'bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground',
                )}
              >
                {label}
                {!whoSels.includes(key) && siblingSels.has(key) && (
                  <span className="ml-1.5 text-[11px] font-normal opacity-70">already logged</span>
                )}
              </button>
            ))}
          </div>
          {/* Multi-person note — spell out exactly what saves, since "8h for
              two people" could plausibly mean 8h each or 4h each. It's 8h
              each: everyone picked gets the full hours. */}
          {canFanOut && whoSels.length > 1 && (
            <p className="mt-1.5 text-[11px] text-muted-foreground leading-snug">
              {isEdit ? (
                // Editing: this row belongs to the first person picked, the
                // rest get rows of their own. Say the hours out loud — "6.5h
                // for two people" could just as easily read as 3.25h each.
                <>
                  Updates this entry and adds one for each other person tagged,
                  same {hours ? `${hours}h` : 'hours'} each.
                  {whoSels.slice(1).some((k) => siblingSels.has(k))
                    && ' Anyone already logged on this day is left alone.'}
                </>
              ) : (
                <>
                  Saves separate entries — each person gets the
                  {activities.length > 1 ? ' split' : ' full'} hours
                  ({whoSels.length} {activities.length > 1 ? `× ${activities.length} entries` : 'entries'}).
                </>
              )}
            </p>
          )}
          {/* Attribution note — make the payroll consequence loud in both
              directions, since the two pills look identical. */}
          {whoSels.some((k) => k !== 'me' && k !== 'other') && (
            <p className="mt-1.5 text-[11px] text-muted-foreground leading-snug">
              Logged on {employeeMembers
                .filter((m) => whoSels.includes(m.id))
                .map((m) => m.displayName || 'their')
                .join(' and ')}&apos;s
              behalf — counts for payroll, same as if they logged it themselves.
            </p>
          )}
          {whoSels.includes('other') && (
            <div className="mt-2">
              <Select
                value={workerKind}
                onValueChange={(v) => {
                  const k = v as WorkerKind;
                  setWorkerKind(k);
                  autoFillRate(workerName, k);
                }}
              >
                <SelectTrigger className="h-9 text-sm w-full max-w-60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(WORKER_KIND_LABELS) as WorkerKind[])
                    .filter((k) => k !== 'owner')
                    .map((k) => (
                      <SelectItem key={k} value={k}>{WORKER_KIND_LABELS[k]}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {/* Their name. Optional — never block a save over it — but it's
                  the difference between "Subcontractor · 8h" and "Dave · 8h"
                  when Brad looks back at the job in three months. */}
              <label className="mt-2 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                {workerKind === 'subcontractor' ? 'Subcontractor' : 'Their name'} (optional)
              </label>
              <input
                type="text"
                value={workerName}
                onChange={(e) => {
                  setWorkerName(e.target.value);
                  autoFillRate(e.target.value, workerKind);
                }}
                placeholder={workerKind === 'subcontractor' ? "e.g. Dave, or Dave's Plastering" : 'e.g. Dave'}
                className="w-full max-w-60 h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {/* What they cost. Ex-GST like every other number in the app.
                  With a rate, these hours become a cost on the job and on
                  the Earned month the day they're logged; without one they
                  cost nothing — better than a guessed number moving the
                  job's profit. */}
              <label className="mt-2 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Their rate $/hour ex-GST (optional)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  min={0}
                  value={costRate}
                  onChange={(e) => { setRateTouched(true); setCostRate(e.target.value); }}
                  placeholder={rememberedRate ? String(rememberedRate) : 'e.g. 45'}
                  className="w-28 h-9 px-3 rounded-lg border border-input bg-background text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {costHint && (
                  <span className="text-[11px] text-muted-foreground">{costHint}</span>
                )}
              </div>
              {/* Manual retire-the-accrual tick. The usual way this gets set
                  is the prompt when their bill is confirmed against the job;
                  this is here for the times that prompt was missed. */}
              {isEdit && parseFloat(costRate) > 0 && (
                <label className="mt-2 flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={labourBilled}
                    onChange={(e) => setLabourBilled(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    They&apos;ve invoiced these hours — their bill is in the books, so
                    stop counting this as money still owed.
                  </span>
                </label>
              )}
              {/* Payroll trap warning — still real for this path: no
                  attribution, so payroll never sees these hours. Fine for
                  a one-off cash-job helper, wrong for staff. */}
              <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-500 leading-snug">
                One-off helpers only — these hours don&apos;t reach payroll. For
                someone on payroll, use their pill above instead.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Job + overhead toggle. Hidden for enquiries — an enquiry is by
          definition a fresh lead with no job yet, and overheads don't make
          sense for them either. Keeps the form tight on the 5:30pm rule. */}
      {type !== 'enquiry' && (
      <div>
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
          Job (optional)
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <JobPicker
              jobs={jobs}
              entries={entries}
              value={jobId}
              onChange={(id) => {
                setJobId(id);
                if (id) setIsOverhead(false);
              }}
              placeholder="No job selected"
              disabled={isOverhead}
              hideOlderWhenActive
            />
          </div>
          {/* Overhead is a money-side concept (a business cost not tied to a
              specific job), so it only makes sense for Expense and Bill Due.
              Hours are labour — you can't have "overhead hours". Hiding the
              button for non-money types keeps the form honest. */}
          {(type === 'expense' || type === 'bill') && (
            <button
              type="button"
              onClick={() => {
                setIsOverhead((v) => !v);
                if (!isOverhead) setJobId('');
              }}
              className={cn(
                'shrink-0 h-9 px-3 rounded-lg text-xs font-semibold border transition-colors',
                isOverhead
                  ? 'bg-blue-100 text-blue-700 border-blue-200'
                  : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
              )}
              title="Mark as overhead — a business expense not tied to a specific job"
            >
              Overhead
            </button>
          )}
        </div>
      </div>
      )}

      {/* Supplier (expense) */}
      {type === 'expense' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Supplier (optional)
          </label>
          <input
            type="text"
            placeholder="e.g. Resene, Mitre 10"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      {/* Due date (bill) */}
      {type === 'bill' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Due date
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      {/* Bill-only edit fields. Surfaced in edit mode so a user can fix
          paid-state / payment ref / company on an existing bill. Not visible
          in create flow because bills usually start as "unpaid + due date". */}
      {type === 'bill' && defaultValues && (
        <>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Company
            </label>
            <input
              type="text"
              placeholder="e.g. Genesis Energy"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            Paid
          </label>
          {paid && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Paid date
                </label>
                <input
                  type="date"
                  value={paidDate}
                  onChange={(e) => setPaidDate(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Payment ref
                </label>
                <input
                  type="text"
                  placeholder="optional"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Actions. In edit mode, an extra Delete button is rendered so the user
          can remove a misclicked entry without a separate UI. */}
      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            className="flex-1 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
        <Button
          className="flex-1 bg-primary"
          onClick={handleSave}
          disabled={!description.trim()}
        >
          {/* isEdit, not defaultValues — a pre-seeded CREATE form (the day
              sheet's "Log hours", the NL parser's hand-off) carries
              defaultValues with no id, and labelling that "Update" reads
              like it's editing something that doesn't exist yet. */}
          {submitLabel ?? (isEdit ? 'Update' : 'Save Entry')}
        </Button>
      </div>
    </div>
  );
}
