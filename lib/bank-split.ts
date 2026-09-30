import type { Entry } from './types';

type SplitEntry = Omit<Entry, 'id' | 'businessId' | 'createdAt' | 'bankTransactionId'>;

/** Keep the personal amount in the bank audit trail without creating a business expense. */
export function asPersonalBankSplit(entry: SplitEntry): SplitEntry {
  return {
    ...entry,
    type: 'note',
    jobId: undefined,
    category: undefined,
    gstApplies: false,
    amountExGst: entry.amount,
    gstComponent: 0,
    description: `[Personal] ${entry.description}`,
  };
}
