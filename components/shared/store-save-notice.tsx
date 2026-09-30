'use client';
import { useStore } from '@/lib/store';

/** Background writes and partial table loads must never fail silently. */
export function StoreSaveNotice() {
  const { error } = useStore();
  if (!error) return null;
  return <div role="alert" className="mx-4 my-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"><p className="font-semibold">Something needs checking</p><p className="mt-1 break-words">{error}</p></div>;
}
