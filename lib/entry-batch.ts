import type { Entry } from './types';
import { entryToRow, rowToEntry } from './supabase/mappers';

type Row = Record<string, unknown>;
type WriteResult = { data: Row[] | null; error: { message: string } | null };

/** Persist the whole shift in one statement, reusing row IDs for safe retries. */
export async function persistEntryBatch(
  batch: Entry[],
  businessId: string,
  ids: Map<string, string>,
  write: (rows: Row[]) => PromiseLike<WriteResult>,
): Promise<Entry[]> {
  if (!businessId || !batch.length) throw new Error('No business or entries to save.');
  const rows = batch.map((entry) => {
    const candidate = entry.id.replace(/^ent_/, '');
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
      ? candidate : ids.get(entry.id) ?? crypto.randomUUID();
    ids.set(entry.id, id);
    return { ...entryToRow({ ...entry, businessId }), id };
  });
  const expected = new Set(rows.map((row) => row.id));
  if (expected.size !== rows.length) throw new Error('Each entry needs its own ID. Nothing was saved.');
  const { data, error } = await write(rows);
  if (error) throw new Error(error.message);
  if (!data || data.length !== rows.length || new Set(data.map((row) => row.id)).size !== rows.length
    || data.some((row) => !expected.has(row.id as string))) {
    throw new Error('The complete entry was not confirmed.');
  }
  return data.map(rowToEntry);
}
