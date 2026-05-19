'use client';

import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { PageHeader } from '@/components/shared/page-header';
import { BankUploadCard } from '@/components/reconcile/bank-upload-card';
import { ReconcileRow } from '@/components/reconcile/reconcile-row';
import { CheckCircle2 } from 'lucide-react';

export default function ReconcilePage() {
  const {
    bankTransactions, entries, jobs,
    updateBankTransaction,
    reconcileToEntry, reconcileAsNewEntry, reconcileAsSplitEntries,
  } = useStore();

  // Pending = unreconciled, sorted by date desc
  const pending = useMemo(
    () => bankTransactions
      .filter((t) => t.status === 'unreconciled')
      .sort((a, b) => b.txnDate.localeCompare(a.txnDate)),
    [bankTransactions],
  );

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Reconcile"
        subtitle={`${pending.length} pending`}
      />

      <div className="px-4 md:px-6 pb-6 space-y-3">
        {/* Upload */}
        <BankUploadCard />

        {/* Pending list */}
        {pending.length === 0 ? (
          <div className="bg-card border border-border rounded-2xl p-6 text-center">
            <CheckCircle2 size={28} className="text-green-500 mx-auto mb-2" strokeWidth={1.8} />
            <p className="text-sm font-semibold text-foreground">All caught up</p>
            <p className="text-xs text-muted-foreground mt-1">
              No unreconciled bank transactions.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {pending.map((txn) => (
              <ReconcileRow
                key={txn.id}
                txn={txn}
                entries={entries}
                jobs={jobs}
                onLinkToEntry={(entryId) => reconcileToEntry(txn.id, entryId)}
                onCreateEntry={(entry) => reconcileAsNewEntry(txn.id, entry)}
                onSplitEntries={(rows) => reconcileAsSplitEntries(txn.id, rows)}
                onIgnore={() => updateBankTransaction(txn.id, { status: 'ignored' })}
                onMarkPersonal={() => updateBankTransaction(txn.id, { status: 'personal' })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
