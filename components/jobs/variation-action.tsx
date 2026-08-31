'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Job, JobVariation, ShiftPhoto, ShiftReport } from '@/lib/types';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Check, CheckCircle2, Copy, Image as ImageIcon, Share2, ShieldCheck } from 'lucide-react';

const GST_RATE = 0.15;

function parseMoney(raw: string): number | null {
  const trimmed = raw.trim();
  const thousands = /k$/i.test(trimmed);
  const parsed = Number.parseFloat(trimmed.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round((thousands ? parsed * 1000 : parsed) * 100) / 100;
}

function money(amount: number): string {
  return amount.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
}

function approvalUrl(token: string): string {
  return `${window.location.origin}/variation/${token}`;
}

interface VariationActionProps {
  job: Job;
  open: boolean;
  onClose: () => void;
  shiftReport?: ShiftReport;
  photos?: ShiftPhoto[];
}

/**
 * Owner review sheet for turning unexpected work into a priced, client-
 * approved variation. Saving creates the link; sharing is always a separate,
 * explicit tap so the app can never contact a client on Brad's behalf.
 */
export function VariationAction({
  job, open, onClose, shiftReport, photos = [],
}: VariationActionProps) {
  const { addJobVariation } = useStore();
  const [title, setTitle] = useState('Additional work');
  const [description, setDescription] = useState(shiftReport?.note ?? '');
  const [amountDraft, setAmountDraft] = useState('');
  const [basis, setBasis] = useState<'ex' | 'incl'>('ex');
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>(photos.map((photo) => photo.id));
  const [saved, setSaved] = useState<JobVariation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const pathsKey = photos.map((photo) => photo.storagePath).join('|');
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const paths = pathsKey ? pathsKey.split('|') : [];
    if (!open || paths.length === 0) return;
    let cancelled = false;
    supabase.storage.from('shift-photos').createSignedUrls(paths, 3600).then(({ data, error: signError }) => {
      if (cancelled || signError || !data) return;
      const next: Record<string, string> = {};
      for (const row of data) if (row.path && row.signedUrl) next[row.path] = row.signedUrl;
      setUrls(next);
    });
    return () => { cancelled = true; };
  }, [open, pathsKey]);

  const typedAmount = parseMoney(amountDraft);
  const amountExGst = typedAmount == null
    ? null
    : basis === 'incl'
      ? Math.round((typedAmount / (1 + GST_RATE)) * 100) / 100
      : typedAmount;
  const amountInclGst = amountExGst == null ? null : Math.round(amountExGst * (1 + GST_RATE) * 100) / 100;
  const basePrice = job.quoteAmount ?? job.invoiceAmount;

  const selectedPhotos = useMemo(
    () => photos.filter((photo) => selectedPhotoIds.includes(photo.id)),
    [photos, selectedPhotoIds],
  );

  function togglePhoto(id: string) {
    setSelectedPhotoIds((current) => (
      current.includes(id) ? current.filter((photoId) => photoId !== id) : [...current, id]
    ));
  }

  async function createVariation() {
    setError(null);
    if (!basePrice || basePrice <= 0) {
      setError('Set the agreed price on this job first, then add the variation.');
      return;
    }
    if (!title.trim()) {
      setError('Give the extra work a short title.');
      return;
    }
    if (amountExGst == null || amountExGst <= 0) {
      setError('Add the price for the extra work.');
      return;
    }
    setBusy(true);
    const created = await addJobVariation({
      jobId: job.id,
      shiftReportId: shiftReport?.id,
      title,
      description,
      amountExGst,
      photoIds: selectedPhotos.map((photo) => photo.id),
    });
    setBusy(false);
    if (!created) {
      setError('That variation was not saved. Check the message on screen and try again.');
      return;
    }
    setSaved(created);
  }

  async function copyLink() {
    if (!saved) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(approvalUrl(saved.approvalToken));
      setCopied(true);
    } catch {
      setError('Could not copy the link. Use Share instead.');
    }
  }

  async function shareLink() {
    if (!saved) return;
    const url = approvalUrl(saved.approvalToken);
    if (!navigator.share) {
      await copyLink();
      return;
    }
    try {
      await navigator.share({
        title: `Extra work for ${job.name}`,
        text: `Please review and approve the extra work for ${job.name}.`,
        url,
      });
    } catch (shareError) {
      if ((shareError as Error)?.name !== 'AbortError') setError('Could not open sharing. You can copy the link instead.');
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-hidden rounded-t-3xl p-0" showCloseButton={false}>
        {saved ? (
          <div className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-6">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-green-100 text-green-700">
              <CheckCircle2 size={28} />
            </div>
            <div className="mx-auto mt-4 max-w-sm text-center">
              <h2 className="text-xl font-bold">Approval link ready</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing has been sent. Share the link when you are happy with it.
              </p>
            </div>
            <div className="mt-5 rounded-2xl border border-border bg-muted/35 p-4">
              <p className="text-sm font-semibold">{saved.title}</p>
              <div className="mt-2 flex items-end justify-between gap-3">
                <span className="text-xs text-muted-foreground">Added to the job if approved</span>
                <span className="text-lg font-bold">{money(saved.amountExGst * (1 + GST_RATE))}</span>
              </div>
              <p className="mt-0.5 text-right text-[11px] text-muted-foreground">incl GST</p>
            </div>
            <div className="mt-4 space-y-2">
              <Button className="h-12 w-full text-base" onClick={shareLink}>
                <Share2 size={18} /> Share approval link
              </Button>
              <Button variant="outline" className="h-12 w-full" onClick={copyLink}>
                {copied ? <Check size={18} /> : <Copy size={18} />}
                {copied ? 'Link copied' : 'Copy link'}
              </Button>
              <Button variant="ghost" className="h-11 w-full" onClick={onClose}>Done</Button>
            </div>
            {error && <p className="mt-3 text-center text-sm font-medium text-destructive">{error}</p>}
          </div>
        ) : (
          <>
            <SheetHeader className="shrink-0 border-b border-border px-5 py-4 text-left">
              <SheetTitle>Price the extra work</SheetTitle>
              <p className="text-sm text-muted-foreground">
                Review it, add the price, then create a client approval link.
              </p>
            </SheetHeader>

            <div className="max-h-[calc(92dvh-88px)] space-y-5 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
              <div className="rounded-2xl border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Job</p>
                <p className="mt-1 font-semibold">{job.name}</p>
                {basePrice && basePrice > 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">Current agreed price: {money(basePrice)} ex GST</p>
                ) : (
                  <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
                    Set the agreed price on the job before sending extra work for approval.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="variation-title" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  What changed?
                </label>
                <input
                  id="variation-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="h-12 w-full rounded-xl border border-input bg-background px-3 text-base"
                  placeholder="Additional preparation"
                />
              </div>

              <div>
                <label htmlFor="variation-description" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  What is needed?
                </label>
                <Textarea
                  id="variation-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  className="resize-none text-base"
                  placeholder="Explain the extra work in plain language for the client."
                />
              </div>

              <div>
                <label htmlFor="variation-amount" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-muted-foreground">$</span>
                  <input
                    id="variation-amount"
                    type="text"
                    inputMode="decimal"
                    value={amountDraft}
                    onChange={(event) => setAmountDraft(event.target.value)}
                    className="h-14 w-full rounded-xl border border-input bg-background pl-7 pr-3 text-xl font-bold"
                    placeholder="0"
                  />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {([
                    { value: 'ex' as const, label: '+ GST' },
                    { value: 'incl' as const, label: 'incl GST' },
                  ]).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setBasis(option.value)}
                      className={cn(
                        'h-11 rounded-xl border text-sm font-semibold',
                        basis === option.value
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-background text-muted-foreground',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {amountExGst != null && amountInclGst != null && (
                  <div className="mt-3 rounded-xl bg-primary/5 px-3 py-3 text-sm">
                    <div className="flex justify-between"><span>Extra work</span><strong>{money(amountInclGst)} incl GST</strong></div>
                    {basePrice != null && (
                      <div className="mt-1 flex justify-between text-muted-foreground">
                        <span>New job total</span><span>{money(basePrice + amountExGst)} ex GST</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {photos.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <ImageIcon size={14} /> Client photos
                    </p>
                    <span className="text-xs text-muted-foreground">{selectedPhotoIds.length} selected</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {photos.map((photo) => (
                      <button
                        key={photo.id}
                        type="button"
                        onClick={() => togglePhoto(photo.id)}
                        aria-pressed={selectedPhotoIds.includes(photo.id)}
                        className={cn(
                          'relative aspect-square overflow-hidden rounded-xl border-2 bg-muted',
                          selectedPhotoIds.includes(photo.id) ? 'border-primary' : 'border-transparent opacity-60',
                        )}
                      >
                        {urls[photo.storagePath] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={urls[photo.storagePath]} alt="Job progress" className="h-full w-full object-cover" />
                        ) : <span className="block h-full w-full animate-pulse" />}
                        {selectedPhotoIds.includes(photo.id) && (
                          <span className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check size={15} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">Only selected photos appear on the client link.</p>
                </div>
              )}

              <div className="rounded-xl bg-green-50 px-3 py-3 text-sm text-green-900">
                <p className="flex items-center gap-2 font-semibold"><ShieldCheck size={17} /> Protected approval</p>
                <p className="mt-1 text-xs leading-relaxed">The price changes only if the client approves. Repeated taps cannot add it twice.</p>
              </div>

              {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>}

              <div className="grid grid-cols-[0.8fr_1.2fr] gap-2">
                <Button variant="outline" className="h-12" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button className="h-12" onClick={createVariation} disabled={busy || !basePrice}>
                  {busy ? 'Creating…' : 'Create approval link'}
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
