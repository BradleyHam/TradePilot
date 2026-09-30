'use client';

import { useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/shared/page-header';
import { QuickHoursForm } from '@/components/entry/quick-hours-form';
import { EntryForm } from '@/components/entry/entry-form';
import { JobForm, type LeadSaveContext } from '@/components/jobs/job-form';
import { BankUploadCard } from '@/components/reconcile/bank-upload-card';
import { ReconcileRow } from '@/components/reconcile/reconcile-row';

// pdf.js is ~600KB so we only load the bill-upload card on demand. ssr:false
// because pdf.js touches `window` during initialisation.
const BillPdfUploadCard = dynamic(
  () => import('@/components/entry/bill-pdf-upload').then((m) => m.BillPdfUploadCard),
  { ssr: false },
);
import { useStore } from '@/lib/store';
import { Entry, EntryType, Job } from '@/lib/types';
import {
  Receipt, DollarSign, Clock, PhoneCall, MessageSquare, FileText, AlertCircle, StickyNote,
  CheckCircle2, ChevronRight, Landmark,
  CalendarPlus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { localTodayISO } from '@/lib/format-date';

const QUICK_TYPES: { type: EntryType; label: string; icon: React.ElementType; color: string }[] = [
  { type: 'expense',  label: 'Expense',  icon: Receipt,       color: 'text-red-500' },
  { type: 'income',   label: 'Income',   icon: DollarSign,    color: 'text-green-500' },
  { type: 'hours',    label: 'Hours',    icon: Clock,         color: 'text-blue-500' },
  { type: 'enquiry',  label: 'Lead',     icon: PhoneCall,     color: 'text-violet-500' },
  { type: 'quote',    label: 'Quote',    icon: FileText,      color: 'text-amber-500' },
  { type: 'bill',     label: 'Bill',     icon: AlertCircle,   color: 'text-orange-500' },
  { type: 'note',     label: 'Note',     icon: StickyNote,    color: 'text-slate-500' },
];

// Valid entry types that can be deep-linked via `?type=` from the Home
// screen's quick-add tiles. Kept narrow on purpose — drop-throughs from the
// Home tiles are expense / income / hours; anything else falls back to the
// default mode.
const DEEP_LINK_TYPES: ReadonlySet<EntryType> = new Set([
  'expense', 'income', 'hours',
]);

export default function EntryPage() {
  const { addEntries, addJob, logContact, businessId } = useStore();
  const searchParams = useSearchParams();

  // Honour `?type=expense|income|hours` deep-link from the Home screen's
  // quick-add tiles: jump straight into the form for that type. Derived at
  // mount-time via lazy initializers so we don't need a setState-in-effect
  // (which the lint config flags as cascading re-render).
  const deepLinkType: EntryType | null = (() => {
    const t = searchParams.get('type');
    if (!t || !DEEP_LINK_TYPES.has(t as EntryType)) return null;
    return t as EntryType;
  })();

  const [showForm, setShowForm] = useState<boolean>(deepLinkType != null);
  const [formType, setFormType] = useState<EntryType>(deepLinkType ?? 'expense');
  const [savedMessage, setSavedMessage] = useState('');
  const [moreTypes, setMoreTypes] = useState(false);
  const pendingSave = useRef<{ fingerprint: string; rows: Entry[] } | null>(null);

  async function handleFormSave(data: Omit<Entry, 'id' | 'businessId' | 'createdAt'>) {
    const nowIso = new Date().toISOString();

    // A new enquiry IS a lead — create the job alongside the entry so it
    // shows up on the Leads tab immediately (mirrors the Tapi webhook, which
    // also creates lead-status jobs). The entry is linked to the job so the
    // two stay associated. If the job insert fails we still save the entry —
    // never lose the logged enquiry over the bookkeeping half.
    let enquiryJobId: string | undefined;
    if (data.type === 'enquiry' && !data.jobId) {
      const desc = data.description.trim();
      const lead = await addJob({
        id: crypto.randomUUID(),
        businessId: businessId ?? '',
        // Best name signal we have — the enquiry text, capped so job lists
        // stay readable. Brad can rename when he writes up the job.
        name: desc.length > 70 ? `${desc.slice(0, 67)}…` : desc,
        clientName: '',
        status: 'lead',
        source: data.leadSource,
        estimatedValue: data.amount,
        notes: `From enquiry logged ${data.entryDate}: ${desc}`,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      enquiryJobId = lead?.id;
    }

    await handleManySave([{ ...data, jobId: data.jobId ?? enquiryJobId }]);
  }

  async function handleManySave(drafts: Omit<Entry, 'id' | 'businessId' | 'createdAt'>[]) {
    const fingerprint = JSON.stringify(drafts);
    if (pendingSave.current?.fingerprint !== fingerprint) {
      pendingSave.current = { fingerprint, rows: drafts.map((draft) => ({
        ...draft, id: crypto.randomUUID(), businessId: businessId ?? '', createdAt: new Date().toISOString(),
      })) };
    }
    if (!await addEntries(pendingSave.current.rows)) {
      throw new Error('Could not confirm the save. Your entry is still here — please retry.');
    }
    pendingSave.current = null;
    showSaved('Saved');
    setShowForm(false);
  }

  async function handleLeadSave(
    data: Omit<Job, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>,
    context?: LeadSaveContext,
  ) {
    const nowIso = new Date().toISOString();
    const lead = await addJob({
      id: crypto.randomUUID(),
      businessId: businessId ?? '',
      createdAt: nowIso,
      updatedAt: nowIso,
      ...data,
    });
    if (!lead) return;

    // The first inbound conversation belongs in the same contact timeline
    // as every later call/text/email. It is distinct from lead source:
    // someone can find Brad through Google, then phone him.
    logContact({
      jobId: lead.id,
      direction: 'in',
      channel: context?.contactChannel ?? 'phone',
      contactedAt: nowIso,
      note: 'Initial lead enquiry',
    });
    showSaved('Lead saved');
    setShowForm(false);
  }

  function showSaved(message: string) {
    setSavedMessage(message);
    setTimeout(() => setSavedMessage(''), 2500);
  }

  function openFormType(type: EntryType) {
    setFormType(type);
    setShowForm(true);
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Log"
        subtitle={new Date().toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' })}
      />

      <div className="px-4 md:px-6 space-y-4 pb-6">

        {/* Saved confirmation */}
        {savedMessage && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
            <CheckCircle2 size={16} />
            {savedMessage}
          </div>
        )}

        {/* Quick type grid — kept at the top so logging a thing (the primary
            reason Brad is on this page) is the first thing in reach. The
            reconcile + bill-PDF sections sit below since they're optional
            housekeeping, not the main action. */}
        {!showForm && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">What do you want to log?</p>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {(moreTypes ? QUICK_TYPES : [QUICK_TYPES[2], QUICK_TYPES[0], QUICK_TYPES[6]]).map(({ type, label, icon: Icon, color }) => (
                <button
                  key={type}
                  onClick={() => openFormType(type)}
                  className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-accent transition-colors min-h-[88px] active:scale-95"
                >
                  <Icon size={22} className={color} strokeWidth={1.8} />
                  <span className="text-sm font-medium text-foreground">{type === 'expense' ? 'Bought something' : label}</span>
                </button>
              ))}
            </div>

            <button type="button" className="min-h-11 w-full text-sm font-medium text-muted-foreground" onClick={() => setMoreTypes((open) => !open)}>{moreTypes ? 'Fewer options' : 'More: income, lead, quote or bill'}</button>
            {/* Site visit tile — separate row because it's structurally
                different from the other tiles (it creates a schedule
                item, not an entry). The deep-link uses a query param so
                the schedule page can auto-open its add form pre-set to
                quote_visit, sparing the user an extra tap. */}
            <Link
              href="/schedule?quickAdd=quote_visit"
              className="flex items-center gap-3 p-4 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-accent transition-colors min-h-[64px] active:scale-[0.98]"
            >
              <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
                <CalendarPlus size={18} className="text-blue-600" strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Schedule a site visit</p>
                <p className="text-xs text-muted-foreground">
                  Get reminders the night before and 1 hour before
                </p>
              </div>
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            </Link>
          </div>
        )}

        {/* Entry form */}
        {showForm && formType === 'enquiry' && (
          <div className="bg-card border border-border rounded-2xl p-4">
            <div className="mb-4">
              <h2 className="font-heading text-lg font-semibold text-foreground">New lead</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Capture the basics now. You can add the detail later.
              </p>
            </div>
            <JobForm
              variant="lead"
              defaultContactChannel="phone"
              defaultValues={{
                status: 'lead',
                leadDate: localTodayISO(),
              }}
              onSave={handleLeadSave}
              onCancel={() => setShowForm(false)}
            />
          </div>
        )}

        {showForm && formType === 'hours' && <div className="rounded-2xl border border-border bg-card p-4"><QuickHoursForm onSaveMany={handleManySave} onCancel={() => setShowForm(false)} /></div>}

        {showForm && formType !== 'enquiry' && formType !== 'hours' && (
          <div className="bg-card border border-border rounded-2xl p-4">
            <EntryForm
              defaultType={formType}
              lockType
              onSaveMany={handleManySave}
              onSave={handleFormSave}
              onCancel={() => setShowForm(false)}
            />
          </div>
        )}

        {/* Bank reconcile — drop a CSV anywhere on this card to import.
            Same flow as the dedicated /reconcile page but inline so Brad
            doesn't have to navigate away from Entry to clear the queue. */}
        {!showForm && <BankReconcileSection />}

        {/* Supplier bill PDF upload — text-extract + LLM parse, lands as
            a draft on Home for confirmation. See components/entry/bill-pdf-upload. */}
        {!showForm && <BillPdfUploadCard />}

        {/* Recent entries */}
        {!showForm && <RecentEntries />}
      </div>
    </div>
  );
}

// ── Inline bank reconcile section ─────────────────────────────────────────
//
// Sits at the top of the Entry tab. Always shows the drop zone; surfaces the
// pending count and (up to) the first three pending transactions inline so
// Brad can clear them without navigating to /reconcile. Anything beyond
// three is one tap away via "View all".
//
function BankReconcileSection() {
  const {
    bankTransactions, entries, jobs,
    updateBankTransaction, reconcileToEntry, reconcileAsNewEntry, reconcileAsSplitEntries,
    markBillsPaid,
  } = useStore();

  const pending = useMemo(
    () => bankTransactions
      .filter((t) => t.status === 'unreconciled')
      .sort((a, b) => b.txnDate.localeCompare(a.txnDate)),
    [bankTransactions],
  );

  const PREVIEW_LIMIT = 3;
  const previewed = pending.slice(0, PREVIEW_LIMIT);
  const overflow = pending.length - previewed.length;

  return (
    <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center">
            <Landmark size={14} className="text-blue-600" strokeWidth={1.8} />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Bank reconcile</p>
            <p className="text-[11px] text-muted-foreground">
              {pending.length === 0
                ? 'No pending transactions'
                : `${pending.length} pending`}
            </p>
          </div>
        </div>
        {pending.length > 0 && (
          <Link
            href="/reconcile"
            className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
          >
            View all
            <ChevronRight size={12} />
          </Link>
        )}
      </div>

      <BankUploadCard bare compact />

      {previewed.length > 0 && (
        <div className="space-y-2.5 pt-1">
          {previewed.map((txn) => (
            <ReconcileRow
              key={txn.id}
              txn={txn}
              entries={entries}
              jobs={jobs}
              onLinkToEntry={(entryId) => reconcileToEntry(txn.id, entryId)}
              onCreateEntry={(entry) => reconcileAsNewEntry(txn.id, entry)}
              onSplitEntries={(rows) => reconcileAsSplitEntries(txn.id, rows)}
              onMatchBills={(billIds, paidDate) => markBillsPaid(txn.id, billIds, paidDate)}
              onIgnore={() => updateBankTransaction(txn.id, { status: 'ignored' })}
              onMarkPersonal={() => updateBankTransaction(txn.id, { status: 'personal' })}
              onMarkTax={(taxKind) => updateBankTransaction(txn.id, { status: 'tax', taxKind })}
            />
          ))}
          {overflow > 0 && (
            <Link
              href="/reconcile"
              className="flex items-center justify-center gap-1 h-10 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            >
              {overflow} more pending — open full reconcile
              <ChevronRight size={12} />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function RecentEntries() {
  const { entries, jobs } = useStore();

  const recent = [...entries]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const TYPE_ICON: Record<string, React.ElementType> = {
    expense: Receipt, income: DollarSign, hours: Clock, enquiry: MessageSquare,
    quote: FileText, bill: AlertCircle, note: StickyNote,
  };

  const TYPE_COLOR: Record<string, string> = {
    expense: 'text-red-500', income: 'text-green-500', hours: 'text-blue-500',
    enquiry: 'text-violet-500', quote: 'text-amber-500', bill: 'text-orange-500', note: 'text-slate-500',
  };

  if (recent.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Recent entries
        </h3>
        {/* Quick exit to the full editable list. Discoverability for the
            new /entries page without forcing a sidebar trip. */}
        <Link
          href="/entries"
          className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
        >
          Browse all
          <ChevronRight size={12} />
        </Link>
      </div>
      <div className="space-y-2">
        {recent.map((entry) => {
          const Icon = TYPE_ICON[entry.type] || StickyNote;
          const job = entry.jobId ? jobs.find((j) => j.id === entry.jobId) : null;
          return (
            <div key={entry.id} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border">
              <Icon size={16} className={cn(TYPE_COLOR[entry.type], 'shrink-0')} strokeWidth={1.8} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{entry.description}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {job?.name && <span>{job.name} · </span>}
                  {entry.entryDate}
                </p>
              </div>
              {entry.amount !== undefined && (
                <span className={cn(
                  'text-sm font-semibold shrink-0',
                  entry.type === 'income' ? 'text-green-600' : 'text-foreground'
                )}>
                  {entry.type === 'expense' ? '-' : '+'}${entry.amount.toLocaleString('en-NZ')}
                </span>
              )}
              {entry.hours !== undefined && (
                <span className="text-sm font-semibold shrink-0 text-blue-600">{entry.hours}h</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
