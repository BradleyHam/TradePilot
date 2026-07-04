'use client';

// Testimonial image maker — lives inside the Facebook composer tab.
//
// Brad pastes the client's review, and the app draws it as the branded
// 1080×1080 card he used to build by hand in Figma (big quote mark, review
// text, five amber stars, name, role). The card is generated CLIENT-SIDE on
// a canvas (lib/testimonial-card.ts) — what you preview is literally the
// file that gets uploaded, and it works from a phone.
//
// On "Create image" the PNG is uploaded through the normal quote_attachments
// pipeline (kind 'testimonial_image', skipCompression so the text stays
// sharp), replacing any previous card for the job, and the composer
// pre-selects it as photo 1 of the post. The review text/author/role are
// also saved onto the job's marketing blob (marketing.review) so the website
// page's Client review block stays in sync.
//
// One card per job on purpose — same rule as marketing.review being a single
// quote. Regenerating replaces the old card (and any stale selection of it).

import { useEffect, useRef, useState } from 'react';
import { Poppins } from 'next/font/google';
import { useStore } from '@/lib/store';
import { renderTestimonialCard, ensureCardFonts } from '@/lib/testimonial-card';
import type { Job, QuoteAttachment } from '@/lib/types';
import { Loader2, Quote, Sparkles, Trash2, AlertCircle, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

// The card's brand font. next/font self-hosts at build time — no runtime
// Google request. 700 draws the big quote mark; 500/600/400 the text.
const poppins = Poppins({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  display: 'swap',
});

const DEFAULT_ROLE = 'Home Owner';

export function TestimonialPanel({
  job, existing, signedUrls, accent, onGenerated,
}: {
  job: Job;
  /** Current testimonial_image attachments for this job (0 or 1 expected). */
  existing: QuoteAttachment[];
  signedUrls: Record<string, string>;
  /** Platform accent colour for the primary button. */
  accent: string;
  /** Called with the new attachment id so the composer can make it photo 1. */
  onGenerated: (attachmentId: string) => void;
}) {
  const {
    getJobMarketing, saveJobMarketing, ensureJobHasQuote,
    addQuoteAttachments, deleteQuoteAttachment,
  } = useStore();
  const saved = getJobMarketing(job.id);

  const [open, setOpen] = useState(existing.length > 0);
  const [quote, setQuote] = useState(saved?.review?.quote ?? '');
  const [author, setAuthor] = useState(saved?.review?.author ?? job.clientName ?? '');
  const [role, setRole] = useState(saved?.review?.role ?? DEFAULT_ROLE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneTick, setDoneTick] = useState(false);

  const current = existing[0];

  // Live preview — re-render the actual card (debounced) as Brad types.
  // The preview IS the output: same renderer, same pixels.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Everything happens inside the debounce tick (including clearing an
    // outdated preview) so the effect body never sets state synchronously.
    const t = setTimeout(async () => {
      if (!open || !quote.trim()) {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
        setPreviewUrl(null);
        return;
      }
      try {
        await ensureCardFonts(poppins.style.fontFamily);
        const blob = await renderTestimonialCard({
          quote, author, role, fontFamily: poppins.style.fontFamily,
        });
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreviewUrl(url);
      } catch {
        /* preview is best-effort; the Create button surfaces real errors */
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, quote, author, role]);
  // Revoke the last object URL on unmount.
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  async function createImage() {
    setErr(null);
    if (!quote.trim()) return;
    setBusy(true);
    try {
      await ensureCardFonts(poppins.style.fontFamily);
      const blob = await renderTestimonialCard({
        quote, author, role, fontFamily: poppins.style.fontFamily,
      });
      const file = new File([blob], 'testimonial.png', { type: 'image/png' });

      const quoteId = await ensureJobHasQuote(job.id);
      if (!quoteId) {
        setErr("Couldn't prepare this job for the image — please try again.");
        return;
      }

      const res = await addQuoteAttachments(quoteId, [
        { file, kind: 'testimonial_image', skipCompression: true },
      ]);
      const newId = res.ids[0];
      if (!newId) {
        setErr('Upload failed — check your connection and try again.');
        return;
      }

      // One card per job: replace any previous version(s) AFTER the new one
      // is safely up, so a failed upload never leaves Brad with nothing.
      for (const old of existing) {
        await deleteQuoteAttachment(old.id);
      }

      // Keep the website page's Client review block in sync with the card.
      await saveJobMarketing(job.id, {
        review: {
          quote: quote.trim(),
          author: author.trim() || undefined,
          role: role.trim() || undefined,
        },
      });

      onGenerated(newId);
      setDoneTick(true);
      setTimeout(() => setDoneTick(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong making the image.');
    } finally {
      setBusy(false);
    }
  }

  async function removeImage() {
    setErr(null);
    for (const old of existing) {
      const res = await deleteQuoteAttachment(old.id);
      if (!res.ok) setErr(res.error ?? "Couldn't remove the image.");
    }
  }

  // Collapsed: a single inviting row. Keeps the composer clean when there's
  // no review to post.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2.5 rounded-xl border border-dashed border-gray-300 px-3 min-h-[48px] text-sm font-medium text-gray-600 transition hover:bg-gray-50"
      >
        <Quote size={16} className="text-gray-400" />
        Got a review from the client? Turn it into an image for the post
      </button>
    );
  }

  const currentUrl = current ? (signedUrls[current.storagePath] ?? null) : null;

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          <Quote size={12} /> Testimonial image
        </p>
        <div className="flex items-center gap-1.5">
          {current && (
            <button
              type="button"
              onClick={removeImage}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-red-500 transition hover:bg-red-50"
            >
              <Trash2 size={12} /> Remove
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full px-2 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-gray-100"
          >
            Hide
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <div className="space-y-2">
          <textarea
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            placeholder="Paste the client's review here, word for word…"
            rows={4}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-[15px] leading-relaxed text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 resize-y"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Client's name"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 min-h-[44px] text-sm text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40"
            />
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder={DEFAULT_ROLE}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 min-h-[44px] text-sm text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40"
            />
          </div>
          <button
            type="button"
            onClick={createImage}
            disabled={busy || !quote.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 min-h-[44px] text-sm font-semibold text-white transition hover:opacity-90 active:translate-y-px disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : doneTick ? <Check size={15} /> : <Sparkles size={15} />}
            {busy ? 'Making the image…' : doneTick ? 'Added as photo 1' : current ? 'Update image' : 'Create image'}
          </button>
          {err && (
            <p className="flex items-start gap-1.5 text-[12px] text-red-600 leading-snug">
              <AlertCircle size={14} className="mt-px shrink-0" /> {err}
            </p>
          )}
        </div>

        {/* Live preview of the exact card that will be uploaded. Falls back to
            the already-uploaded card when the fields are empty. */}
        <div className={cn('mx-auto w-full max-w-[180px]', poppins.className)}>
          <div className="aspect-square w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            {previewUrl ? (
              <img src={previewUrl} alt="Testimonial card preview" className="h-full w-full object-cover" />
            ) : currentUrl ? (
              <img src={currentUrl} alt="Current testimonial card" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-gray-300">
                Preview appears as you type
              </div>
            )}
          </div>
          <p className="mt-1 text-center text-[10px] text-gray-400">1080 × 1080 — exactly what posts</p>
        </div>
      </div>
    </div>
  );
}
