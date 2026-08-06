'use client';

// Project preview — a faithful-ish render of how the painters-wanaka project
// page will look once published (hero image, title, location/date, lead +
// overview paragraphs, services, before/after galleries). Every copy block is
// editable inline, with AI rewrite (+ undo) per block. Save draft persists the
// reviewed copy; Publish writes the page into the site repo.
//
// Mirrors app/projects/[slug]/page.tsx in the painters-wanaka repo. Rendered
// on a white surface so it reads as "the website", not the app.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useStore } from '@/lib/store';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { SocialPanel } from './social-panel';
import type { Job, QuoteAttachment } from '@/lib/types';
import {
  Sparkles, Plus, Minus, Undo2, Loader2, Check, Globe, Pencil,
  MapPin, Calendar, CheckCircle, AlertCircle, RefreshCw, Eye, EyeOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const SERVICE_BY_WORKTYPE: Record<string, string[]> = {
  interior: ['Interior Painting'],
  exterior: ['Exterior Painting'],
  cedar: ['Cedar Restoration'],
  wallpaper: ['Wallpaper Installation'],
  roof: ['Roof Painting'],
  mixed: ['Exterior Painting', 'Interior Painting'],
};

// Canonical service vocabulary the live site recognises (drives the Services
// list + the internal service links on the project page).
const SERVICE_OPTIONS = [
  'Interior Painting',
  'Exterior Painting',
  'Cedar Restoration',
  'Wallpaper Installation',
  'Roof Painting',
  'Commercial Painting',
];

type ApiResp = {
  ok?: boolean;
  error?: string;
  text?: string;
  title?: string;
  description?: string;
  overview?: string[];
  result?: { slug?: string; committed?: boolean; commitMessage?: string; commitError?: string };
};

async function authedPost(path: string, payload: unknown): Promise<{ httpOk: boolean; body: ApiResp }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  let body: ApiResp = {};
  try { body = (await res.json()) as ApiResp; } catch { /* non-JSON */ }
  return { httpOk: res.ok, body };
}

function monthYear(job: Job): string | null {
  const iso = job.endDate || job.updatedAt;
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-NZ', { month: 'long', year: 'numeric' });
}

export function ProjectPreviewSheet({
  job, beforeImages, afterImages, processImages, testimonialImages = [], signedUrls, onClose,
}: {
  job: Job;
  beforeImages: QuoteAttachment[];
  afterImages: QuoteAttachment[];
  processImages: QuoteAttachment[];
  /** Generated testimonial cards — social-post only, never in web galleries. */
  testimonialImages?: QuoteAttachment[];
  signedUrls: Record<string, string>;
  onClose: () => void;
}) {
  const { getJobMarketing, saveJobMarketing, refresh } = useStore();
  const saved = getJobMarketing(job.id);

  // Three screens: the website page preview, and a post composer per platform.
  const [tab, setTab] = useState<'website' | 'facebook' | 'instagram'>('website');

  const defaultServices = job.workType ? (SERVICE_BY_WORKTYPE[job.workType] ?? ['Exterior Painting']) : ['Exterior Painting'];

  // Photos hidden from the published page (quote_attachments.ids). Opt-out:
  // everything shows unless Brad taps the eye to hide it. Persisted with the
  // draft so publish (server-side) can skip the same set.
  const [excludedIds, setExcludedIds] = useState<string[]>(saved?.excludedImageIds ?? []);
  function toggleImage(id: string) {
    setExcludedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  const isExcluded = (id: string) => excludedIds.includes(id);
  const visibleBefore = beforeImages.filter((a) => !isExcluded(a.id));
  const visibleAfter = afterImages.filter((a) => !isExcluded(a.id));
  const visibleProcess = processImages.filter((a) => !isExcluded(a.id));

  const sliderAvailable = visibleBefore.length > 0 && visibleAfter.length > 0;

  const [title, setTitle] = useState(saved?.title || job.name);
  const [description, setDescription] = useState(saved?.description || '');
  const [overview, setOverview] = useState<string[]>(saved?.overview && saved.overview.length ? saved.overview : []);
  const [services, setServices] = useState<string[]>(saved?.services && saved.services.length ? saved.services : defaultServices);
  const [heroMode, setHeroMode] = useState<'image' | 'slider'>(saved?.heroMode ?? (sliderAvailable ? 'slider' : 'image'));

  // Client review — the client's own words, kept verbatim (no AI tools on
  // purpose). Empty quote = no review block on the published page.
  const [reviewQuote, setReviewQuote] = useState(saved?.review?.quote ?? '');
  const [reviewAuthor, setReviewAuthor] = useState(saved?.review?.author ?? '');
  const [heroBeforeId, setHeroBeforeId] = useState<string | undefined>(saved?.heroBeforeId ?? beforeImages[0]?.id);
  const [heroAfterId, setHeroAfterId] = useState<string | undefined>(saved?.heroAfterId ?? afterImages[0]?.id);

  // Hero picks resolve against VISIBLE images only — hiding the chosen hero
  // falls back to the first still-visible photo.
  const chosenAfter = visibleAfter.find((a) => a.id === heroAfterId) ?? visibleAfter[0];
  const chosenBefore = visibleBefore.find((a) => a.id === heroBeforeId) ?? visibleBefore[0];
  const chosenAfterUrl = chosenAfter ? (signedUrls[chosenAfter.storagePath] ?? null) : null;
  const chosenBeforeUrl = chosenBefore ? (signedUrls[chosenBefore.storagePath] ?? null) : null;

  const [drafting, setDrafting] = useState(false);
  const hasCopy = description.trim().length > 0 || overview.length > 0;
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [publishErr, setPublishErr] = useState<string | null>(null);
  const published = saved?.status === 'published';

  // Whole-page AI edit state.
  const [bodyBusy, setBodyBusy] = useState(false);
  const [canUndoAll, setCanUndoAll] = useState(false);
  const prevBodyRef = useRef<{ description: string; overview: string[] } | null>(null);

  // Auto-fill the body on first open when there's no overview yet, so the
  // preview shows the FULL page copy (what will publish). Keeps Brad's
  // existing description; only fills what's empty.
  const triedDraft = useRef(false);
  useEffect(() => {
    if (triedDraft.current) return;
    if (overview.length > 0 || afterImages.length === 0) return;
    triedDraft.current = true;
    void runDraft('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runDraft(mode: 'auto' | 'full') {
    setDrafting(true);
    try {
      const { httpOk, body } = await authedPost('/api/marketing/draft', { jobId: job.id });
      if (!httpOk || body.ok === false) {
        alert(`Couldn't draft the page: ${body.error ?? 'unknown error'}`);
        return;
      }
      // 'full' (Regenerate) replaces everything; 'auto' only fills empty fields.
      if (body.title && (mode === 'full' || !title.trim())) setTitle(body.title);
      if (body.description && (mode === 'full' || !description.trim())) setDescription(body.description);
      if (Array.isArray(body.overview)) setOverview(body.overview);
    } finally {
      setDrafting(false);
    }
  }

  function setParagraph(i: number, v: string) {
    setOverview((prev) => prev.map((p, idx) => (idx === i ? v : p)));
  }

  async function rewriteAll(kind: 'shorter' | 'longer' | 'rewrite') {
    const instruction =
      kind === 'shorter' ? 'Make the whole thing shorter and tighter overall — fewer words; you may merge or drop paragraphs, but keep the key points and all facts.'
      : kind === 'longer' ? 'Add a little more relevant detail across the whole thing, keeping the same facts.'
      : 'Rewrite the whole thing to read more naturally and professionally, keeping the same facts.';
    setBodyBusy(true);
    try {
      const { httpOk, body } = await authedPost('/api/marketing/rewrite-all', { description, overview, instruction });
      if (!httpOk || (!body.description && !(body.overview && body.overview.length))) {
        alert(`Couldn't rewrite the page: ${body.error ?? 'unknown error'}`);
        return;
      }
      prevBodyRef.current = { description, overview };
      setCanUndoAll(true);
      if (typeof body.description === 'string') setDescription(body.description);
      if (Array.isArray(body.overview)) setOverview(body.overview);
    } finally {
      setBodyBusy(false);
    }
  }
  function undoAll() {
    if (!prevBodyRef.current) return;
    setDescription(prevBodyRef.current.description);
    setOverview(prevBodyRef.current.overview);
    prevBodyRef.current = null;
    setCanUndoAll(false);
  }

  async function handleSave(): Promise<boolean> {
    setSaving(true);
    try {
      const res = await saveJobMarketing(job.id, {
        title: title.trim(),
        description: description.trim(),
        overview: overview.map((p) => p.trim()).filter(Boolean),
        services,
        heroMode,
        heroBeforeId,
        heroAfterId,
        excludedImageIds: excludedIds,
        review: reviewQuote.trim()
          ? { quote: reviewQuote.trim(), author: reviewAuthor.trim() || undefined }
          : undefined, // explicit undefined clears a previously-saved review
      });
      if (!res.ok) { alert(`Couldn't save: ${res.error ?? 'unknown error'}`); return false; }
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    setPublishErr(null);
    setPublishMsg(null);
    // Persist the current edits first so publish uses exactly what's on screen.
    const ok = await handleSave();
    if (!ok) return;
    setPublishBusy(true);
    try {
      const { httpOk, body } = await authedPost('/api/marketing/publish', {
        jobId: job.id,
        mode: published ? 'update' : 'create',
      });
      if (!httpOk || body.ok === false) {
        setPublishErr(body.error ?? 'Publish failed — check the dev-server console.');
        return;
      }
      const r = body.result;
      const verb = published ? 'Updated' : 'Published';
      if (r?.committed) {
        setPublishMsg(`${verb} & committed${r.slug ? ` (${r.slug})` : ''}. Run “git push” in painters-wanaka to deploy.`);
      } else {
        setPublishMsg(`${verb}${r?.slug ? ` (${r.slug})` : ''} — files written, but auto-commit failed${r?.commitError ? `: ${r.commitError}` : ''}. Commit + push manually.`);
      }
      await refresh();
    } finally {
      setPublishBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // Height via class (not inline style) so the desktop-drawer md:h-full
        // override in ui/sheet.tsx can win. Wide drawer — it previews a
        // website project page.
        className="p-0 gap-0 overflow-hidden h-[94vh] [--desktop-sheet-w:52rem]"
      >
        {/* Header (non-shrinking) */}
        <div className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Marketing</p>
              <p className="text-sm font-medium truncate">{job.name}</p>
            </div>
            <div className="flex items-center gap-2">
              {tab === 'website' && (
                <button
                  type="button"
                  onClick={() => runDraft('full')}
                  disabled={drafting}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 min-h-[36px] text-xs font-medium transition hover:bg-muted disabled:opacity-50"
                >
                  {drafting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {hasCopy ? 'Regenerate copy' : 'Draft copy'}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center rounded-lg border border-border bg-background px-3 min-h-[36px] text-sm font-medium transition hover:bg-muted"
              >
                Close
              </button>
            </div>
          </div>
          {/* Screen switcher — website page vs Facebook vs Instagram post */}
          <div className="mt-2.5 grid grid-cols-3 rounded-lg border border-border bg-muted p-0.5 text-sm font-medium">
            <button
              type="button"
              onClick={() => setTab('website')}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-md min-h-[40px] transition',
                tab === 'website' ? 'bg-background shadow-sm' : 'text-muted-foreground',
              )}
            >
              <Globe size={15} /> Website
            </button>
            <button
              type="button"
              onClick={() => setTab('facebook')}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-md min-h-[40px] transition',
                tab === 'facebook' ? 'bg-background shadow-sm' : 'text-muted-foreground',
              )}
            >
              <span className="inline-flex h-[15px] w-[15px] items-center justify-center rounded bg-[#1877F2] text-[10px] font-bold leading-none text-white" aria-hidden>f</span>
              Facebook
            </button>
            <button
              type="button"
              onClick={() => setTab('instagram')}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-md min-h-[40px] transition',
                tab === 'instagram' ? 'bg-background shadow-sm' : 'text-muted-foreground',
              )}
            >
              <span
                className="inline-flex h-[15px] w-[15px] items-center justify-center rounded text-[9px] font-bold leading-none text-white"
                style={{ background: 'linear-gradient(45deg, #F58529, #DD2A7B 55%, #8134AF)' }}
                aria-hidden
              >
                ◎
              </span>
              Instagram
            </button>
          </div>
        </div>

        {/* Body (scrollable) — white canvas for both screens */}
        <div className={cn('flex-1 overflow-y-auto bg-white', tab !== 'website' && 'hidden')}>
          <div className="mx-auto max-w-3xl px-5 py-8 text-gray-900">
            {drafting && !hasCopy ? (
              <div className="flex items-center gap-2 py-20 justify-center text-gray-500">
                <Loader2 size={18} className="animate-spin" /> Drafting your project page…
              </div>
            ) : (
              <>
                {/* Hero */}
                {heroMode === 'slider' && sliderAvailable ? (
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <HeroPane label="Before" url={chosenBeforeUrl} />
                    <HeroPane label="After" url={chosenAfterUrl} />
                  </div>
                ) : (
                  <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-gray-100 mb-3">
                    {chosenAfterUrl
                      ? <img src={chosenAfterUrl} alt={title} className="h-full w-full object-cover" />
                      : <div className="flex h-full items-center justify-center text-gray-400 text-sm">No photo yet</div>}
                  </div>
                )}

                {/* Hero controls — pick single image vs slider, and which photos. */}
                <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Hero</span>
                    <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-xs font-medium">
                      <button
                        type="button"
                        onClick={() => setHeroMode('image')}
                        className={cn('rounded-md px-2.5 py-1 transition', heroMode === 'image' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}
                      >
                        Single image
                      </button>
                      <button
                        type="button"
                        onClick={() => setHeroMode('slider')}
                        disabled={!sliderAvailable}
                        className={cn('rounded-md px-2.5 py-1 transition disabled:opacity-40', heroMode === 'slider' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}
                      >
                        Before/after slider
                      </button>
                    </div>
                  </div>
                  {heroMode === 'slider' && !sliderAvailable && (
                    <p className="text-[11px] text-gray-400">Add at least one before and one after photo to use a slider.</p>
                  )}
                  {heroMode === 'image' ? (
                    <ThumbPicker label="Main image" images={visibleAfter} signedUrls={signedUrls} selectedId={chosenAfter?.id} onSelect={setHeroAfterId} />
                  ) : sliderAvailable ? (
                    <div className="space-y-2">
                      <ThumbPicker label="Before" images={visibleBefore} signedUrls={signedUrls} selectedId={chosenBefore?.id} onSelect={setHeroBeforeId} />
                      <ThumbPicker label="After" images={visibleAfter} signedUrls={signedUrls} selectedId={chosenAfter?.id} onSelect={setHeroAfterId} />
                      <p className="text-[11px] text-gray-400">Tip: pick the same area before + after so the slider lines up.</p>
                    </div>
                  ) : null}
                </div>

                {/* Title */}
                <EditableText
                  value={title}
                  onChange={setTitle}
                  variant="title"
                  aiContext={`Project page title for a painting job in ${job.location ?? 'Wanaka'}.`}
                />

                {/* Meta */}
                <div className="mt-3 mb-5 flex flex-wrap gap-4 text-sm text-gray-500">
                  {job.location && <span className="inline-flex items-center gap-1.5"><MapPin size={15} className="text-gray-400" />{job.location}</span>}
                  {monthYear(job) && <span className="inline-flex items-center gap-1.5"><Calendar size={15} className="text-gray-400" />Completed {monthYear(job)}</span>}
                </div>

                {/* Whole-page AI edit — rewrites lead + all paragraphs together. */}
                <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 px-2 py-1.5">
                  <span className="text-[11px] font-medium text-gray-500">Edit whole page:</span>
                  {bodyBusy ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500"><Loader2 size={12} className="animate-spin" /> Rewriting…</span>
                  ) : (
                    <>
                      <ToolBtn icon={Minus} label="Shorten" onClick={() => rewriteAll('shorter')} />
                      <ToolBtn icon={Sparkles} label="Rewrite" onClick={() => rewriteAll('rewrite')} />
                      <ToolBtn icon={Plus} label="Longer" onClick={() => rewriteAll('longer')} />
                      {canUndoAll && <ToolBtn icon={Undo2} label="Undo" onClick={undoAll} />}
                    </>
                  )}
                </div>

                {/* Lead description */}
                <EditableText
                  value={description}
                  onChange={setDescription}
                  variant="lead"
                  placeholder="Lead paragraph — the opening copy on the page."
                  aiContext={`Lead paragraph for the "${title}" project page.`}
                />

                {/* Overview paragraphs */}
                <div className="mt-3 space-y-3">
                  {overview.map((para, i) => (
                    <EditableText
                      key={i}
                      value={para}
                      onChange={(v) => setParagraph(i, v)}
                      variant="body"
                      aiContext={`Body paragraph ${i + 1} of the "${title}" project page.`}
                      onRemove={overview.length > 1 ? () => setOverview((prev) => prev.filter((_, idx) => idx !== i)) : undefined}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => setOverview((prev) => [...prev, ''])}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-500 transition hover:bg-gray-50"
                  >
                    <Plus size={13} /> Add paragraph
                  </button>
                </div>

                {/* The live page auto-appends this line — shown read-only so the preview matches. */}
                <p className="mt-3 text-[15px] leading-relaxed text-gray-400">
                  Looking for a similar result in Wanaka and surrounding areas? We also handle{' '}
                  {services.map((s) => s.toLowerCase()).join(', ')}. Contact Lakeside Painting for a free quote.
                  <span className="ml-1 text-[11px] italic">(added automatically)</span>
                </p>

                {/* Services — selectable pills (multi-select). */}
                <div className="mt-8 border-t border-gray-200 pt-6">
                  <h3 className="text-sm font-medium text-gray-900 mb-3">Services Provided</h3>
                  <div className="flex flex-wrap gap-2">
                    {SERVICE_OPTIONS.map((s) => {
                      const on = services.includes(s);
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setServices((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition',
                            on ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50',
                          )}
                        >
                          {on ? <Check size={13} /> : <CheckCircle size={13} className="text-gray-400" />} {s}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[11px] text-gray-400">Tap to toggle. These show on the page and drive its service links.</p>
                </div>

                {/* Client review — optional testimonial. Rendered on the live
                    page as a quote block; left out entirely when empty. */}
                <div className="mt-8 border-t border-gray-200 pt-6">
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <h3 className="text-sm font-medium text-gray-900">Client review</h3>
                    <span className="text-[11px] text-gray-400">Optional — leave empty to skip</span>
                  </div>
                  <blockquote className="border-l-2 border-gray-300 pl-4">
                    <textarea
                      value={reviewQuote}
                      onChange={(e) => setReviewQuote(e.target.value)}
                      placeholder={'What did the client say? e.g. "The team were tidy, on time and the house looks brand new."'}
                      className="w-full resize-none [field-sizing:content] min-h-[3.5rem] rounded-lg bg-transparent px-2 py-1.5 -mx-2 text-base italic text-gray-600 leading-relaxed outline-none placeholder:not-italic placeholder:text-gray-300 hover:bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/30 transition"
                    />
                    <div className="mt-1 flex items-center gap-1 text-sm text-gray-500">
                      <span aria-hidden>—</span>
                      <input
                        value={reviewAuthor}
                        onChange={(e) => setReviewAuthor(e.target.value)}
                        placeholder="Client's first name"
                        className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 font-medium outline-none placeholder:font-normal placeholder:text-gray-300 hover:bg-gray-50 focus:bg-white focus:ring-2 focus:ring-primary/30 transition"
                      />
                    </div>
                  </blockquote>
                  <p className="mt-2 text-[11px] text-gray-400">
                    The client&apos;s words go on the page exactly as written here — no AI rewriting.
                  </p>
                </div>

                {/* Galleries — every photo on the job, with a show/hide toggle.
                    Hidden photos stay on the job but are skipped on publish. */}
                {(afterImages.length > 0 || beforeImages.length > 0 || processImages.length > 0) && (
                  <p className="mt-10 text-[11px] text-gray-400">
                    Tap the eye on a photo to hide it from the published page. Hidden photos stay on the job.
                  </p>
                )}
                {/* After gallery */}
                {afterImages.length > 0 && (
                  <div className="mt-4">
                    <GalleryHeading label="After" shown={visibleAfter.length} total={afterImages.length} />
                    <Gallery images={afterImages} signedUrls={signedUrls} excludedIds={excludedIds} onToggle={toggleImage} />
                  </div>
                )}
                {/* Before gallery */}
                {beforeImages.length > 0 && (
                  <div className="mt-10">
                    <GalleryHeading label="Before" shown={visibleBefore.length} total={beforeImages.length} />
                    <Gallery images={beforeImages} signedUrls={signedUrls} excludedIds={excludedIds} onToggle={toggleImage} />
                  </div>
                )}
                {/* Process gallery */}
                {processImages.length > 0 && (
                  <div className="mt-10">
                    <GalleryHeading label="Process" shown={visibleProcess.length} total={processImages.length} />
                    <Gallery images={processImages} signedUrls={signedUrls} excludedIds={excludedIds} onToggle={toggleImage} />
                  </div>
                )}

              </>
            )}
          </div>
        </div>

        {/* Social screens — kept mounted so captions/photo picks survive tab switches. */}
        <div className={cn('flex-1 overflow-y-auto bg-white', tab !== 'facebook' && 'hidden')}>
          <div className="mx-auto max-w-3xl px-5 py-6 text-gray-900">
            <SocialPanel
              platform="facebook"
              job={job}
              afterImages={afterImages}
              beforeImages={beforeImages}
              processImages={processImages}
              testimonialImages={testimonialImages}
              signedUrls={signedUrls}
              websiteDescription={description}
              websiteOverview={overview}
              websiteServices={services}
            />
          </div>
        </div>
        <div className={cn('flex-1 overflow-y-auto bg-white', tab !== 'instagram' && 'hidden')}>
          <div className="mx-auto max-w-3xl px-5 py-6 text-gray-900">
            <SocialPanel
              platform="instagram"
              job={job}
              afterImages={afterImages}
              beforeImages={beforeImages}
              processImages={processImages}
              testimonialImages={testimonialImages}
              signedUrls={signedUrls}
              websiteDescription={description}
              websiteOverview={overview}
              websiteServices={services}
            />
          </div>
        </div>

        {/* Footer (non-shrinking) — website actions only */}
        <div className={cn('shrink-0 border-t border-border px-4 py-3 space-y-2', tab !== 'website' && 'hidden')}>
          {publishMsg && (
            <p className="flex items-start gap-1.5 text-[12px] text-primary leading-snug">
              <Check size={14} className="mt-px shrink-0" /> {publishMsg}
            </p>
          )}
          {publishErr && (
            <p className="flex items-start gap-1.5 text-[12px] text-destructive leading-snug">
              <AlertCircle size={14} className="mt-px shrink-0" /> {publishErr}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground leading-tight">
              {published
                ? 'Update overwrites just this page + commits it. Then git push to deploy.'
                : 'On publish, AI names + optimises the photos, writes the page, and commits it (you push to deploy).'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 min-h-[40px] text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                {saving ? <Loader2 size={15} className="animate-spin" /> : savedTick ? <Check size={15} /> : null}
                {savedTick ? 'Saved' : 'Save draft'}
              </button>
              <button
                type="button"
                onClick={handlePublish}
                disabled={publishBusy || !description.trim() || visibleAfter.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 min-h-[40px] text-sm font-medium text-primary-foreground transition hover:bg-primary/80 active:translate-y-px disabled:opacity-50"
              >
                {publishBusy ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />}
                {published
                  ? (publishBusy ? 'Updating…' : 'Update published page')
                  : (publishBusy ? 'Publishing…' : 'Publish to website')}
              </button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GalleryHeading({ label, shown, total }: { label: string; shown: number; total: number }) {
  return (
    <h2 className="text-xl font-bold text-gray-900 mb-4">
      {label}
      {shown < total && (
        <span className="ml-2 text-sm font-medium text-gray-400">{shown} of {total} shown</span>
      )}
    </h2>
  );
}

function Gallery({
  images, signedUrls, excludedIds, onToggle,
}: {
  images: QuoteAttachment[];
  signedUrls: Record<string, string>;
  excludedIds: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {images.map((a) => {
        const url = signedUrls[a.storagePath] ?? null;
        const hidden = excludedIds.includes(a.id);
        return (
          <div key={a.id} className="relative aspect-[4/3] overflow-hidden rounded-lg bg-gray-100">
            {url
              ? (
                <img
                  src={url}
                  alt={a.fileName ?? 'photo'}
                  className={cn('h-full w-full object-cover transition', hidden && 'opacity-30 grayscale')}
                />
              )
              : <div className="flex h-full items-center justify-center"><Loader2 size={16} className="animate-spin text-gray-400" /></div>}
            {hidden && (
              <span className="absolute left-2 bottom-2 rounded-full bg-gray-900/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                Hidden
              </span>
            )}
            <button
              type="button"
              onClick={() => onToggle(a.id)}
              title={hidden ? 'Show on the published page' : 'Hide from the published page'}
              aria-label={hidden ? 'Show this photo on the published page' : 'Hide this photo from the published page'}
              className={cn(
                'absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full shadow-sm transition active:scale-95',
                hidden ? 'bg-gray-900 text-white' : 'bg-white/90 text-gray-700 hover:bg-white',
              )}
            >
              {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function HeroPane({ label, url }: { label: string; url: string | null }) {
  return (
    <figure className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-gray-100">
      <span className="absolute left-2 top-2 z-10 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">{label}</span>
      {url
        ? <img src={url} alt={label} className="h-full w-full object-cover" />
        : <div className="flex h-full items-center justify-center"><Loader2 size={16} className="animate-spin text-gray-400" /></div>}
    </figure>
  );
}

function ThumbPicker({
  label, images, signedUrls, selectedId, onSelect,
}: {
  label: string;
  images: QuoteAttachment[];
  signedUrls: Record<string, string>;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-gray-500">{label}</p>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {images.map((a) => {
          const url = signedUrls[a.storagePath] ?? null;
          const selected = a.id === selectedId;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              aria-label={`Use this ${label.toLowerCase()} image`}
              className={cn(
                'relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-gray-100 ring-2 transition',
                selected ? 'ring-gray-900' : 'ring-transparent hover:ring-gray-300',
              )}
            >
              {url
                ? <img src={url} alt="" className="h-full w-full object-cover" />
                : <span className="flex h-full items-center justify-center"><Loader2 size={12} className="animate-spin text-gray-400" /></span>}
              {selected && (
                <span className="absolute inset-0 flex items-center justify-center bg-gray-900/30">
                  <Check size={16} className="text-white" />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Editable block with per-block AI rewrite + undo ─────────────────────────

function EditableText({
  value, onChange, variant, aiContext, placeholder, onRemove,
}: {
  value: string;
  onChange: (v: string) => void;
  variant: 'title' | 'lead' | 'body';
  aiContext: string;
  placeholder?: string;
  onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const prevRef = useRef<string | null>(null);

  const textClass = variant === 'title'
    ? 'text-3xl font-bold tracking-tight text-gray-900'
    : variant === 'lead'
      ? 'text-base text-gray-600 leading-relaxed'
      : 'text-[15px] text-gray-600 leading-relaxed';

  async function runAi(instruction: string) {
    setBusy(true);
    try {
      const { httpOk, body } = await authedPost('/api/marketing/rewrite', { text: value, instruction, context: aiContext });
      if (!httpOk || !body.text) { alert(`AI rewrite failed: ${body.error ?? 'unknown error'}`); return; }
      prevRef.current = value;
      setCanUndo(true);
      onChange(body.text);
    } finally {
      setBusy(false);
    }
  }
  function undo() {
    if (prevRef.current != null) { onChange(prevRef.current); prevRef.current = null; setCanUndo(false); }
  }

  return (
    <div className="group relative">
      {editing ? (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          placeholder={placeholder}
          className={cn(
            'w-full rounded-lg border border-primary/40 bg-white px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-primary/30 resize-none [field-sizing:content] min-h-[2.5rem]',
            textClass,
          )}
        />
      ) : (
        <p
          onClick={() => setEditing(true)}
          className={cn(
            textClass,
            'whitespace-pre-wrap cursor-text rounded-lg -mx-2 px-2 py-1.5 hover:bg-gray-50 transition-colors',
            !value && 'text-gray-300',
          )}
        >
          {value || placeholder || '(empty — click to edit)'}
        </p>
      )}

      {/* Floating toolbar (desktop hover / focus) */}
      <div className="absolute -top-3 right-0 z-10 flex items-center gap-0.5 rounded-full border border-gray-200 bg-white px-1 py-0.5 shadow-sm opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {busy ? (
          <span className="inline-flex items-center gap-1 px-1.5 text-[11px] text-gray-500"><Loader2 size={12} className="animate-spin" /> Writing…</span>
        ) : (
          <>
            <ToolBtn icon={Pencil} label={editing ? 'Done' : 'Edit'} onClick={() => setEditing((e) => !e)} />
            <ToolBtn icon={Sparkles} label="Rewrite" onClick={() => runAi('Rewrite this to read more naturally and professionally, keeping the same meaning and facts.')} />
            {variant !== 'title' && (
              <>
                <ToolBtn icon={Plus} label="Longer" onClick={() => runAi('Expand this with a little more relevant detail, keeping the same facts.')} />
                <ToolBtn icon={Minus} label="Shorter" onClick={() => runAi('Make this more concise while keeping the key points.')} />
              </>
            )}
            {canUndo && <ToolBtn icon={Undo2} label="Undo" onClick={undo} />}
            {onRemove && <ToolBtn icon={Minus} label="Remove" onClick={onRemove} danger />}
          </>
        )}
      </div>
    </div>
  );
}

function ToolBtn({
  icon: Icon, label, onClick, danger,
}: {
  icon: typeof Sparkles;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[11px] font-medium transition hover:bg-gray-100',
        danger ? 'text-red-500' : 'text-gray-600',
      )}
    >
      <Icon size={12} /> <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
