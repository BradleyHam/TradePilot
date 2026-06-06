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
import type { Job, QuoteAttachment } from '@/lib/types';
import {
  Sparkles, Plus, Minus, Undo2, Loader2, Check, Globe, Pencil,
  MapPin, Calendar, CheckCircle, AlertCircle, RefreshCw,
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
  job, beforeImages, afterImages, processImages, signedUrls, onClose,
}: {
  job: Job;
  beforeImages: QuoteAttachment[];
  afterImages: QuoteAttachment[];
  processImages: QuoteAttachment[];
  signedUrls: Record<string, string>;
  onClose: () => void;
}) {
  const { getJobMarketing, saveJobMarketing, refresh } = useStore();
  const saved = getJobMarketing(job.id);

  const defaultServices = job.workType ? (SERVICE_BY_WORKTYPE[job.workType] ?? ['Exterior Painting']) : ['Exterior Painting'];
  const sliderAvailable = beforeImages.length > 0 && afterImages.length > 0;

  const [title, setTitle] = useState(saved?.title || job.name);
  const [description, setDescription] = useState(saved?.description || '');
  const [overview, setOverview] = useState<string[]>(saved?.overview && saved.overview.length ? saved.overview : []);
  const [services, setServices] = useState<string[]>(saved?.services && saved.services.length ? saved.services : defaultServices);
  const [heroMode, setHeroMode] = useState<'image' | 'slider'>(saved?.heroMode ?? (sliderAvailable ? 'slider' : 'image'));
  const [heroBeforeId, setHeroBeforeId] = useState<string | undefined>(saved?.heroBeforeId ?? beforeImages[0]?.id);
  const [heroAfterId, setHeroAfterId] = useState<string | undefined>(saved?.heroAfterId ?? afterImages[0]?.id);

  const chosenAfter = afterImages.find((a) => a.id === heroAfterId) ?? afterImages[0];
  const chosenBefore = beforeImages.find((a) => a.id === heroBeforeId) ?? beforeImages[0];
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
        className="p-0 gap-0 overflow-hidden"
        style={{ height: '94vh' }}
      >
        {/* Header (non-shrinking) */}
        <div className="shrink-0 flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Project page preview</p>
            <p className="text-sm font-medium truncate">{job.name}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runDraft('full')}
              disabled={drafting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 min-h-[36px] text-xs font-medium transition hover:bg-muted disabled:opacity-50"
            >
              {drafting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {hasCopy ? 'Regenerate copy' : 'Draft copy'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center rounded-lg border border-border bg-background px-3 min-h-[36px] text-sm font-medium transition hover:bg-muted"
            >
              Close
            </button>
          </div>
        </div>

        {/* Body (scrollable) — white "website" canvas */}
        <div className="flex-1 overflow-y-auto bg-white">
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
                    <ThumbPicker label="Main image" images={afterImages} signedUrls={signedUrls} selectedId={chosenAfter?.id} onSelect={setHeroAfterId} />
                  ) : sliderAvailable ? (
                    <div className="space-y-2">
                      <ThumbPicker label="Before" images={beforeImages} signedUrls={signedUrls} selectedId={chosenBefore?.id} onSelect={setHeroBeforeId} />
                      <ThumbPicker label="After" images={afterImages} signedUrls={signedUrls} selectedId={chosenAfter?.id} onSelect={setHeroAfterId} />
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

                {/* After gallery */}
                {afterImages.length > 0 && (
                  <div className="mt-10">
                    <h2 className="text-xl font-bold text-gray-900 mb-4">After</h2>
                    <Gallery images={afterImages} signedUrls={signedUrls} />
                  </div>
                )}
                {/* Before gallery */}
                {beforeImages.length > 0 && (
                  <div className="mt-10">
                    <h2 className="text-xl font-bold text-gray-900 mb-4">Before</h2>
                    <Gallery images={beforeImages} signedUrls={signedUrls} />
                  </div>
                )}
                {/* Process gallery */}
                {processImages.length > 0 && (
                  <div className="mt-10">
                    <h2 className="text-xl font-bold text-gray-900 mb-4">Process</h2>
                    <Gallery images={processImages} signedUrls={signedUrls} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer (non-shrinking) */}
        <div className="shrink-0 border-t border-border px-4 py-3 space-y-2">
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
                disabled={publishBusy || !description.trim() || afterImages.length === 0}
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

function Gallery({ images, signedUrls }: { images: QuoteAttachment[]; signedUrls: Record<string, string> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {images.map((a) => {
        const url = signedUrls[a.storagePath] ?? null;
        return (
          <div key={a.id} className="relative aspect-[4/3] overflow-hidden rounded-lg bg-gray-100">
            {url
              ? <img src={url} alt={a.fileName ?? 'photo'} className="h-full w-full object-cover" />
              : <div className="flex h-full items-center justify-center"><Loader2 size={16} className="animate-spin text-gray-400" /></div>}
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
