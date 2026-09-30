'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Clock3, Plus, UserPlus, Users } from 'lucide-react';
import { useStore } from '@/lib/store';
import { buildProgressSnapshot, jobPersonHours, latestProgressAt } from '@/lib/job-progress';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatEntryDate } from '@/lib/format-date';
import type {
  BusinessMember,
  CrewPerson,
  JobProgressPerson,
  JobProgressSnapshot,
  WorkerKind,
} from '@/lib/types';

interface WorkLeftSheetProps {
  jobId: string | null;
  open: boolean;
  onClose: () => void;
  defaultAsOfDate?: string;
}

type DurationChoice = '' | '0' | '0.5' | '1' | '1.5' | '2' | 'other';

interface PersonChoice {
  key: string;
  personName: string;
  workerKind: WorkerKind;
  businessMemberId?: string;
  crewPersonId?: string;
}

const DURATION_CHOICES: Array<{ value: Exclude<DurationChoice, ''>; label: string }> = [
  { value: '0', label: 'No work left' },
  { value: '0.5', label: '½ day' },
  { value: '1', label: '1 day' },
  { value: '1.5', label: '1½ days' },
  { value: '2', label: '2 days' },
  { value: 'other', label: 'Other' },
];

const ADD_PERSON_CATEGORIES: Array<{
  value: CrewPerson['workerKind'];
  label: string;
}> = [
  { value: 'experienced', label: 'Painter' },
  { value: 'helper', label: 'Brush hand' },
  { value: 'apprentice', label: 'Apprentice' },
  { value: 'subcontractor', label: 'Subcontractor' },
];

const CATEGORY_LABELS: Record<WorkerKind, string> = {
  owner: 'Owner',
  experienced: 'Painter',
  helper: 'Brush hand',
  apprentice: 'Apprentice',
  subcontractor: 'Subcontractor',
};

function localTodayISO(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function money(value: number): string {
  return value.toLocaleString('en-NZ', {
    style: 'currency',
    currency: 'NZD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function hours(value: number): string {
  return value.toLocaleString('en-NZ', { maximumFractionDigits: 2 });
}

function personKey(person: Pick<JobProgressPerson, 'businessMemberId' | 'crewPersonId' | 'id'>): string {
  if (person.businessMemberId) return `member:${person.businessMemberId}`;
  if (person.crewPersonId) return `crew:${person.crewPersonId}`;
  return `snapshot:${person.id}`;
}

function rosterChoices(
  teamMembers: BusinessMember[],
  crewPeople: CrewPerson[],
  previousPeople: JobProgressPerson[],
): PersonChoice[] {
  const choices: PersonChoice[] = teamMembers.map((member) => ({
    key: `member:${member.id}`,
    personName: member.role === 'owner' ? 'Me' : (member.displayName || 'Team member'),
    workerKind: member.role === 'owner' ? 'owner' : (member.workerKind ?? 'helper'),
    businessMemberId: member.id,
  }));
  // Older databases can briefly have no owner membership row while the app
  // still correctly resolves the signed-in business owner. "Me" must remain
  // available; a source-less snapshot person is valid and stays auditable by
  // its saved name/category.
  if (!choices.some((choice) => choice.workerKind === 'owner')) {
    choices.unshift({ key: 'owner:self', personName: 'Me', workerKind: 'owner' });
  }

  for (const person of crewPeople) {
    if (person.archivedAt) continue;
    choices.push({
      key: `crew:${person.id}`,
      personName: person.displayName,
      workerKind: person.workerKind,
      crewPersonId: person.id,
    });
  }

  const existingKeys = new Set(choices.map((choice) => choice.key));
  for (const person of previousPeople) {
    const key = personKey(person);
    if (existingKeys.has(key)) continue;
    choices.push({
      key,
      personName: person.personName,
      workerKind: person.workerKind,
      businessMemberId: person.businessMemberId,
      crewPersonId: person.crewPersonId,
    });
    existingKeys.add(key);
  }

  return choices.sort((a, b) => {
    if (a.workerKind === 'owner') return -1;
    if (b.workerKind === 'owner') return 1;
    return a.personName.localeCompare(b.personName);
  });
}

function durationFromSnapshot(
  snapshot: JobProgressSnapshot | null,
  people: JobProgressPerson[],
  consumedSinceSnapshot: number,
): { choice: DurationChoice; otherDays: string; hoursPerDay: string } {
  if (!snapshot) return { choice: '', otherDays: '', hoursPerDay: '8' };
  if (snapshot.state === 'complete') return { choice: '0', otherDays: '', hoursPerDay: '8' };

  const recordedHoursPerDay = people.find((person) => (person.hoursPerDay ?? 0) > 0)?.hoursPerDay ?? 8;
  const remainingNow = Math.max(0, snapshot.remainingPersonHours - consumedSinceSnapshot);
  if (remainingNow <= 0) {
    return { choice: '', otherDays: '', hoursPerDay: String(recordedHoursPerDay) };
  }
  const recordedDays = people.find((person) => (person.inputDays ?? 0) > 0)?.inputDays
    ?? (people.length > 0 ? remainingNow / people.length / recordedHoursPerDay : 0);
  const currentDays = people.length > 0
    ? remainingNow / people.length / recordedHoursPerDay
    : recordedDays;
  const normalised = round2(currentDays);
  const preset = ['0.5', '1', '1.5', '2'].find((value) => Number(value) === normalised);
  return preset
    ? { choice: preset as DurationChoice, otherDays: '', hoursPerDay: String(recordedHoursPerDay) }
    : {
        choice: 'other',
        otherDays: normalised > 0 ? String(normalised) : '',
        hoursPerDay: String(recordedHoursPerDay),
      };
}

export function WorkLeftSheet({
  jobId,
  open,
  onClose,
  defaultAsOfDate,
}: WorkLeftSheetProps) {
  const [busy, setBusy] = useState(false);

  return (
    <Sheet
      open={open && jobId !== null}
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
    >
      {open && jobId !== null && (
        <WorkLeftForm
          key={`${jobId}:${defaultAsOfDate ?? 'today'}`}
          jobId={jobId}
          defaultAsOfDate={defaultAsOfDate}
          onClose={onClose}
          onBusyChange={setBusy}
        />
      )}
    </Sheet>
  );
}

function WorkLeftForm({
  jobId,
  defaultAsOfDate,
  onClose,
  onBusyChange,
}: {
  jobId: string;
  defaultAsOfDate?: string;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const {
    jobs,
    entries,
    teamMembers,
    crewPeople,
    jobAssignments,
    jobProgressSnapshots,
    jobProgressPeople,
    addCrewPerson,
    recordJobProgress,
  } = useStore();
  const job = jobs.find((candidate) => candidate.id === jobId);
  const today = localTodayISO();
  const initialAsOfDate = defaultAsOfDate && defaultAsOfDate <= today
    ? defaultAsOfDate
    : today;
  const previousSnapshot = latestProgressAt(jobProgressSnapshots, jobId, initialAsOfDate);
  const previousPeople = previousSnapshot
    ? jobProgressPeople.filter((person) => person.snapshotId === previousSnapshot.id)
    : [];
  const actualAtInitialDate = job
    ? jobPersonHours(entries.filter((entry) => !entry.isDraft), job.id, initialAsOfDate).total
    : 0;
  const consumedSinceSnapshot = previousSnapshot?.state === 'forecast'
    ? Math.max(0, actualAtInitialDate - previousSnapshot.actualPersonHours)
    : 0;
  const initialDuration = durationFromSnapshot(
    previousSnapshot,
    previousPeople,
    consumedSinceSnapshot,
  );
  const choices = rosterChoices(teamMembers, crewPeople, previousPeople);

  const [asOfDate, setAsOfDate] = useState(initialAsOfDate);
  const [durationChoice, setDurationChoice] = useState<DurationChoice>(initialDuration.choice);
  const [otherDays, setOtherDays] = useState(initialDuration.otherDays);
  const [hoursPerDay, setHoursPerDay] = useState(initialDuration.hoursPerDay);
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => {
    const selected = new Set(previousPeople.map(personKey));
    // A saved forecast is an auditable crew snapshot. Reopening it must not
    // silently add today's default owner/assignees and multiply the hours.
    if (!previousSnapshot) {
      const owner = choices.find((choice) => choice.workerKind === 'owner');
      if (owner) selected.add(owner.key);
      const assignedUserIds = new Set(
        jobAssignments
          .filter((assignment) => assignment.jobId === jobId)
          .map((assignment) => assignment.userId),
      );
      for (const member of teamMembers) {
        if (assignedUserIds.has(member.userId)) selected.add(`member:${member.id}`);
      }
    }
    return [...selected];
  });
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');
  const [newPersonKind, setNewPersonKind] = useState<CrewPerson['workerKind'] | ''>('');
  const [addingBusy, setAddingBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);
  const historicalEstimate = asOfDate < today;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    onBusyChange(saving || addingBusy);
    return () => onBusyChange(false);
  }, [saving, addingBusy, onBusyChange]);

  const selectedPeople = choices.filter((choice) => selectedKeys.includes(choice.key));
  const durationDays = durationChoice === 'other'
    ? Number.parseFloat(otherDays)
    : durationChoice === '' ? Number.NaN : Number(durationChoice);
  const hoursInDay = Number.parseFloat(hoursPerDay);
  const isComplete = durationChoice === '0';
  const validDuration = isComplete || (Number.isFinite(durationDays) && durationDays > 0);
  const validHoursPerDay = isComplete || (Number.isFinite(hoursInDay) && hoursInDay > 0 && hoursInDay <= 24);
  const remainingHoursEach = !isComplete && validDuration && validHoursPerDay
    ? round2(durationDays * hoursInDay)
    : 0;
  const remainingPersonHours = round2(remainingHoursEach * selectedPeople.length);

  const preview = useMemo(() => {
    if (!job || !validDuration || !validHoursPerDay) return null;
    if (!isComplete && selectedPeople.length === 0) return null;
    try {
      return buildProgressSnapshot({
        job,
        entries: entries.filter((entry) => !entry.isDraft),
        asOfDate,
        state: isComplete ? 'complete' : 'forecast',
        people: isComplete
          ? []
          : selectedPeople.map(() => ({ remainingHours: remainingHoursEach })),
      });
    } catch {
      return null;
    }
  }, [job, entries, asOfDate, isComplete, validDuration, validHoursPerDay, selectedPeople, remainingHoursEach]);

  function togglePerson(key: string) {
    setError(null);
    setSelectedKeys((current) => current.includes(key)
      ? current.filter((candidate) => candidate !== key)
      : [...current, key]);
  }

  function chooseDuration(value: Exclude<DurationChoice, ''>) {
    setError(null);
    setDurationChoice(value);
    if (value !== 'other') setOtherDays('');
  }

  async function handleAddPerson() {
    const name = newPersonName.trim().replace(/\s+/g, ' ');
    if (!name) {
      setPersonError('Enter their name first.');
      return;
    }
    if (!newPersonKind) {
      setPersonError('Choose whether they are a painter, brush hand, apprentice or subcontractor.');
      return;
    }
    const alreadyKnown = choices.find(
      (choice) => choice.personName.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (alreadyKnown) {
      setSelectedKeys((current) => current.includes(alreadyKnown.key)
        ? current
        : [...current, alreadyKnown.key]);
      setNewPersonName('');
      setAddingPerson(false);
      setPersonError(null);
      return;
    }

    setAddingBusy(true);
    setPersonError(null);
    let person: CrewPerson | null = null;
    try {
      person = await addCrewPerson({ displayName: name, workerKind: newPersonKind });
    } catch {
      setPersonError('That person could not be saved. Please try again.');
    } finally {
      setAddingBusy(false);
    }
    if (!person) {
      setPersonError((current) => current ?? 'That person could not be saved. Please try again.');
      return;
    }
    const key = `crew:${person.id}`;
    setSelectedKeys((current) => current.includes(key) ? current : [...current, key]);
    setNewPersonName('');
    setNewPersonKind('');
    setAddingPerson(false);
  }

  async function handleSave() {
    setError(null);
    if (!job) {
      setError('That job could not be found.');
      return;
    }
    if (!asOfDate || asOfDate > today) {
      setError('Choose today or an earlier date.');
      return;
    }
    if (!validDuration) {
      setError('Choose how much work is left.');
      return;
    }
    if (!validHoursPerDay) {
      setError('Enter the number of working hours in a day.');
      return;
    }
    if (!isComplete && selectedPeople.length === 0) {
      setError('Choose who will finish the work.');
      return;
    }

    setSaving(true);
    let saved: JobProgressSnapshot | null = null;
    try {
      saved = await recordJobProgress({
        jobId,
        asOfDate,
        state: isComplete ? 'complete' : 'forecast',
        people: isComplete ? [] : selectedPeople.map((person) => ({
          businessMemberId: person.businessMemberId,
          crewPersonId: person.crewPersonId,
          personName: person.personName,
          workerKind: person.workerKind,
          remainingHours: remainingHoursEach,
          inputDays: durationDays,
          hoursPerDay: hoursInDay,
        })),
      });
    } catch {
      setError('Progress was not saved. Please try again.');
    } finally {
      setSaving(false);
    }
    if (!saved) {
      setError((current) => current ?? 'Progress was not saved. Please try again.');
      return;
    }
    onClose();
  }

  return (
    <SheetContent
      side="bottom"
      className="rounded-t-3xl p-0 [--desktop-sheet-w:32rem]"
      showCloseButton={false}
      initialFocus={headingRef}
    >
      <div className="flex max-h-[92dvh] flex-col overflow-hidden md:h-full md:max-h-none">
        <SheetHeader className="shrink-0 border-b border-border px-5 pb-4 pt-5 text-left">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Clock3 size={18} />
            </span>
            <div className="min-w-0">
              <SheetTitle ref={headingRef} tabIndex={-1} className="text-lg font-bold leading-tight outline-none">
                {historicalEstimate ? 'How much work was left?' : 'How much work is left?'}
              </SheetTitle>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {job?.name ?? 'Job'}
              </p>
              {historicalEstimate && (
                <p className="mt-1 text-xs font-medium text-primary">
                  At {formatEntryDate(asOfDate)}, for the selected report
                </p>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <fieldset>
            <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {historicalEstimate ? `Time left at ${formatEntryDate(asOfDate)}` : 'Time left on site'}
            </legend>
            <div className="flex flex-wrap gap-2">
              {DURATION_CHOICES.map((option) => {
                const selected = durationChoice === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => chooseDuration(option.value)}
                    className={cn(
                      'min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card text-foreground hover:border-primary/35',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            {durationChoice === 'other' && (
              <div className="mt-3">
                <label htmlFor="work-left-days" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Working days left
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="work-left-days"
                    type="number"
                    inputMode="decimal"
                    min={0.1}
                    step={0.25}
                    value={otherDays}
                    onChange={(event) => { setOtherDays(event.target.value); setError(null); }}
                    placeholder="e.g. 3.5"
                    className="h-11 w-32 rounded-xl border border-input bg-background px-3 text-base tabular-nums outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
              </div>
            )}
          </fieldset>

          {!isComplete && durationChoice !== '' && (
            <section>
              <label htmlFor="work-left-hours-per-day" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Hours in a working day
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="work-left-hours-per-day"
                  type="number"
                  inputMode="decimal"
                  min={0.5}
                  max={24}
                  step={0.5}
                  value={hoursPerDay}
                  onChange={(event) => { setHoursPerDay(event.target.value); setError(null); }}
                  className="h-11 w-24 rounded-xl border border-input bg-background px-3 text-base font-semibold tabular-nums outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-sm text-muted-foreground">hours each</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Change this if these are shorter or longer site days.
              </p>
            </section>
          )}

          {!isComplete && durationChoice !== '' && (
            <fieldset>
              <legend className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Users size={14} /> Who will finish it?
              </legend>
              <div className="flex flex-wrap gap-2">
                {choices.map((person) => {
                  const selected = selectedKeys.includes(person.key);
                  return (
                    <button
                      key={person.key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => togglePerson(person.key)}
                      className={cn(
                        'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card text-foreground hover:border-primary/35',
                      )}
                    >
                      {selected && <Check size={15} />}
                      {person.personName}
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-expanded={addingPerson}
                  onClick={() => {
                    setAddingPerson((current) => !current);
                    setPersonError(null);
                  }}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-primary/45 bg-card px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary/5"
                >
                  <Plus size={15} /> Add someone
                </button>
              </div>

              {selectedPeople.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {selectedPeople.map((person) => (
                    <span key={person.key}>{person.personName} · {CATEGORY_LABELS[person.workerKind]}</span>
                  ))}
                </div>
              )}

              {addingPerson && (
                <div className="mt-3 rounded-2xl border border-primary/20 bg-primary/[0.035] p-3.5">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <UserPlus size={16} className="text-primary" /> Add someone to your crew
                  </div>
                  <label htmlFor="work-left-person-name" className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Name
                  </label>
                  <input
                    id="work-left-person-name"
                    type="text"
                    value={newPersonName}
                    onChange={(event) => { setNewPersonName(event.target.value); setPersonError(null); }}
                    placeholder="e.g. Kenneth"
                    className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />

                  <p className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Category
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ADD_PERSON_CATEGORIES.map((category) => (
                      <button
                        key={category.value}
                        type="button"
                        aria-pressed={newPersonKind === category.value}
                        onClick={() => { setNewPersonKind(category.value); setPersonError(null); }}
                        className={cn(
                          'min-h-11 rounded-full border px-3 text-xs font-semibold transition-colors',
                          newPersonKind === category.value
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-foreground',
                        )}
                      >
                        {category.label}
                      </button>
                    ))}
                  </div>

                  {personError && (
                    <p role="alert" className="mt-3 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                      {personError}
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 flex-1"
                      disabled={addingBusy}
                      onClick={() => {
                        setAddingPerson(false);
                        setNewPersonName('');
                        setNewPersonKind('');
                        setPersonError(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      className="min-h-11 flex-1"
                      disabled={addingBusy || !newPersonName.trim() || !newPersonKind}
                      onClick={() => { void handleAddPerson(); }}
                    >
                      {addingBusy ? 'Adding…' : 'Add to crew'}
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    Planning only. This does not create a login or put them on payroll.
                  </p>
                </div>
              )}
            </fieldset>
          )}

          {durationChoice !== '' && (
            <section className={cn(
              'rounded-2xl border p-4',
              isComplete ? 'border-emerald-200 bg-emerald-50/70' : 'border-primary/20 bg-primary/[0.035]',
            )} aria-live="polite">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {isComplete
                  ? 'No work left'
                  : historicalEstimate
                    ? `Forecast at ${formatEntryDate(asOfDate)}`
                    : 'Current forecast'}
              </p>
              {preview ? (
                <>
                  <div className="mt-2 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
                        {Math.round(preview.progressFraction * 100)}% done
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {isComplete
                          ? `${hours(preview.actualPersonHours)} person-hours logged`
                          : `${hours(preview.actualPersonHours)}h logged + ${hours(remainingPersonHours)}h left`}
                      </p>
                    </div>
                    {!isComplete && (
                      <p className="shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
                        {hours(preview.forecastPersonHours)}h total
                      </p>
                    )}
                  </div>
                  {preview.jobValueExGst > 0 ? (
                    <p className="mt-3 border-t border-border/60 pt-3 text-sm text-foreground">
                      About <span className="font-bold tabular-nums">{money(preview.earnedToDateExGst)}</span>
                      {' '}of {money(preview.jobValueExGst)} work done
                      <span className="text-xs text-muted-foreground"> · ex GST</span>
                    </p>
                  ) : (
                    <p className="mt-3 border-t border-border/60 pt-3 text-xs leading-relaxed text-amber-700">
                      Progress can be saved, but add a job value before it can estimate earned income.
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {!isComplete && selectedPeople.length === 0
                    ? 'Choose who will finish the work to see the total person-hours.'
                    : 'Complete the estimate above to see the progress calculation.'}
                </p>
              )}
            </section>
          )}

          <div>
            <label htmlFor="work-left-as-of-date" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Progress as at
            </label>
            <input
              id="work-left-as-of-date"
              type="date"
              value={asOfDate}
              max={today}
              onChange={(event) => { setAsOfDate(event.target.value); setError(null); }}
              className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              This is a management estimate only. It does not change the job status, create income, change invoices, or affect tax.
            </p>
          </div>

          {error && (
            <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <div
          className="shrink-0 border-t border-border bg-background px-5 pt-3"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
        >
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-12 flex-1"
              disabled={saving || addingBusy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-12 flex-[1.5]"
              disabled={saving || !validDuration || !validHoursPerDay || (!isComplete && selectedPeople.length === 0)}
              onClick={() => { void handleSave(); }}
            >
              {saving ? 'Saving…' : isComplete ? 'Save 100% done' : 'Save progress'}
            </Button>
          </div>
        </div>
      </div>
    </SheetContent>
  );
}
