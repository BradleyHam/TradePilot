'use client';

// ── Marketing tab ───────────────────────────────────────────────────────────
//
// Turns finished jobs into shareable content. For every "done" job
// (completed / invoiced / paid) it shows:
//   - BEFORE photos — already captured at the site-visit wrap-up
//     (quote_attachments kind 'before_photo' / 'scope_photo').
//   - AFTER photos — added here once the job's finished (kind 'after_photo').
//   - A short description + a publish status (draft → ready).
//
// IMPORTANT — no new infra. Photos reuse the EXISTING quote_attachments
// pipeline (ensureJobHasQuote + addQuoteAttachments + deleteQuoteAttachment,
// images served via batched signed URLs from the private quote-attachments
// bucket). The description + status persist as a settings JSON blob via
// getJobMarketing / saveJobMarketing. So this page adds ZERO database tables
// and can't disturb anything that already works.
//
// Next phase (not built yet): a "Publish to website" action that hands the
// chosen photos + blurb to the add-project skill / Painters Wanaka site, then
// Facebook / Instagram. The "Ready" status is the seam for that.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import {
  PhotoThumb, PhotoLightbox, isImageName, type LightboxImage,
} from '@/components/jobs/photo-lightbox';
import type { Job, QuoteAttachment, QuoteAttachmentKind } from '@/lib/types';
import { Megaphone, Camera, ImagePlus, Loader2, Images, Sparkles, Globe } from 'lucide-react';
import { ProjectPreviewSheet } from '@/components/marketing/project-preview-sheet';
import { cn } from '@/lib/utils';

// Jobs worth showcasing — the terminal "the work is done" statuses.
const DONE_STATUSES: ReadonlySet<Job['status']> = new Set(['completed', 'invoiced', 'paid']);

// "Before" bucket folds in scope photos, since the site-visit wrap-up files
// the work-area shots as scope_photo as well as before_photo.
const BEFORE_KINDS: ReadonlySet<QuoteAttachmentKind> = new Set(['before_photo', 'scope_photo']);

/** Images only (no PDFs) — the marketing tab is photos, not documents. */
function isAcceptedImage(f: File): boolean {
  const lower = (f.name || '').toLowerCase();
  return f.type.startsWith('image/') || lower.endsWith('.heic') || lower.endsWith('.heif');
}

/** Display a completion date if we have one. */
function formatDoneDate(job: Job): string | null {
  const iso = job.endDate || job.updatedAt;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function MarketingPage() {
  const { jobs, quotes, quoteAttachments, loading } = useStore();

  // Done jobs, most-recently-finished first (recent work is what Brad wants
  // to post). Jobs with no date sink to the bottom.
  const doneJobs = useMemo(() => {
    const sortKey = (j: Job) => j.endDate || j.updatedAt || '';
    return jobs
      .filter((j) => DONE_STATUSES.has(j.status))
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  }, [jobs]);

  // Quote ids per job + all image attachments, so we can batch-sign in one go.
  const { attachmentsByJob, allImagePaths } = useMemo(() => {
    const quoteIdsByJob = new Map<string, Set<string>>();
    for (const q of quotes) {
      if (!q.jobId) continue;
      (quoteIdsByJob.get(q.jobId) ?? quoteIdsByJob.set(q.jobId, new Set()).get(q.jobId)!).add(q.id);
    }
    const byJob = new Map<string, QuoteAttachment[]>();
    const paths = new Set<string>();
    for (const j of doneJobs) {
      const qids = quoteIdsByJob.get(j.id);
      if (!qids) { byJob.set(j.id, []); continue; }
      const atts = quoteAttachments.filter((a) => qids.has(a.quoteId));
      byJob.set(j.id, atts);
      for (const a of atts) {
        if (isImageName(a.fileName ?? a.storagePath)) paths.add(a.storagePath);
      }
    }
    return { attachmentsByJob: byJob, allImagePaths: Array.from(paths) };
  }, [doneJobs, quotes, quoteAttachments]);

  // Batch-sign every image path once. Re-runs whenever the set of paths
  // changes (e.g. after an upload or delete). 1-hour expiry.
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const pathsKey = allImagePaths.join('|');
  useEffect(() => {
    const paths = pathsKey ? pathsKey.split('|') : [];
    if (paths.length === 0) return;
    let cancelled = false;
    supabase.storage
      .from('quote-attachments')
      .createSignedUrls(paths, 3600)
      .then(({ data, error }) => {
        if (cancelled || error || !data) {
          if (error) console.error('[marketing] failed to sign thumbnails:', error);
          return;
        }
        setSignedUrls((prev) => {
          const next = { ...prev };
          for (const row of data) {
            if (row.signedUrl && row.path) next[row.path] = row.signedUrl;
          }
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [pathsKey]);

  // Page-level lightbox: which job's photos and which index.
  const [lightbox, setLightbox] = useState<{ jobId: string; index: number } | null>(null);

  if (loading) {
    return (
      <div className="px-4 md:px-6">
        <PageHeader title="Marketing" />
        <div className="flex items-center gap-2 px-1 py-10 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" /> Loading your jobs…
        </div>
      </div>
    );
  }

  const readyCount = doneJobs.filter((j) => {
    const atts = attachmentsByJob.get(j.id) ?? [];
    return atts.some((a) => a.kind === 'after_photo');
  }).length;

  const subtitle = doneJobs.length === 0
    ? undefined
    : `${doneJobs.length} finished ${doneJobs.length === 1 ? 'job' : 'jobs'}` +
      (readyCount > 0 ? ` · ${readyCount} with after photos` : '');

  // Build the lightbox image list for the currently-open job.
  const lightboxImages: LightboxImage[] = (() => {
    if (!lightbox) return [];
    const atts = (attachmentsByJob.get(lightbox.jobId) ?? [])
      .filter((a) => isImageName(a.fileName ?? a.storagePath))
      .sort((a, b) => beforeFirst(a) - beforeFirst(b));
    return atts.map((a) => ({
      id: a.id,
      fileName: a.fileName ?? a.storagePath.split('/').pop() ?? 'photo',
      signedUrl: signedUrls[a.storagePath] ?? null,
    }));
  })();

  return (
    <div className="pb-10">
      <PageHeader title="Marketing" subtitle={subtitle} />

      {doneJobs.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No finished jobs yet"
          description="Once a job is marked completed, invoiced or paid it'll show up here — with its site-visit photos ready to pair with after shots and a description."
        />
      ) : (
        <div className="px-4 md:px-6 space-y-4 max-w-3xl">
          {doneJobs.map((job) => (
            <JobMarketingCard
              key={job.id}
              job={job}
              attachments={attachmentsByJob.get(job.id) ?? []}
              signedUrls={signedUrls}
              onOpenPhoto={(index) => setLightbox({ jobId: job.id, index })}
            />
          ))}
        </div>
      )}

      {lightbox && lightboxImages.length > 0 && (
        <PhotoLightbox
          images={lightboxImages}
          index={Math.min(lightbox.index, lightboxImages.length - 1)}
          onIndexChange={(next) => setLightbox((cur) => (cur ? { ...cur, index: next } : cur))}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

// Before/scope photos sort ahead of after photos in the grid + lightbox.
function beforeFirst(a: QuoteAttachment): number {
  return BEFORE_KINDS.has(a.kind) ? 0 : 1;
}

// ── One job's marketing card ────────────────────────────────────────────────

function JobMarketingCard({
  job, attachments, signedUrls, onOpenPhoto,
}: {
  job: Job;
  attachments: QuoteAttachment[];
  signedUrls: Record<string, string>;
  onOpenPhoto: (lightboxIndex: number) => void;
}) {
  const {
    ensureJobHasQuote, addQuoteAttachments, deleteQuoteAttachment, getJobMarketing,
  } = useStore();

  const afterInputRef = useRef<HTMLInputElement>(null);
  const beforeInputRef = useRef<HTMLInputElement>(null);
  const processInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Image attachments split into before + after, before first (matches the
  // lightbox order built on the page).
  const images = attachments
    .filter((a) => isImageName(a.fileName ?? a.storagePath))
    .sort((a, b) => beforeFirst(a) - beforeFirst(b));
  const beforeImages = images.filter((a) => BEFORE_KINDS.has(a.kind));
  const afterImages = images.filter((a) => a.kind === 'after_photo');
  const processImages = images.filter((a) => a.kind === 'process_photo');

  // Map an attachment id → its index in the flat lightbox list.
  const lightboxIndexOf = (id: string) => images.findIndex((a) => a.id === id);

  // Marketing metadata (settings-backed). The copy lives in the preview sheet now.
  const saved = getJobMarketing(job.id);
  const status = saved?.status ?? 'draft';
  const [previewOpen, setPreviewOpen] = useState(false);

  async function handleFiles(files: File[], kind: 'after_photo' | 'before_photo' | 'process_photo') {
    const accepted = files.filter(isAcceptedImage);
    const rejected = files.length - accepted.length;
    if (rejected > 0) {
      alert(`${rejected} file${rejected === 1 ? '' : 's'} skipped — only photos can be added here.`);
    }
    if (accepted.length === 0) return;
    setUploading(true);
    try {
      const quoteId = await ensureJobHasQuote(job.id);
      if (!quoteId) {
        alert("Couldn't prepare this job for photos — please try again.");
        return;
      }
      const res = await addQuoteAttachments(quoteId, accepted.map((file) => ({ file, kind })));
      if (res.failed > 0) {
        alert(`${res.inserted} added, ${res.failed} failed — check your connection and try again.`);
      }
    } finally {
      setUploading(false);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>, kind: 'after_photo' | 'before_photo' | 'process_photo') {
    const files = Array.from(e.target.files ?? []);
    void handleFiles(files, kind);
    e.target.value = ''; // allow re-picking the same file
  }

  const doneDate = formatDoneDate(job);
  const hasAfter = afterImages.length > 0;
  const hasCopy = !!saved?.description?.trim() || !!(saved?.overview && saved.overview.length > 0);
  const showcaseReady = hasAfter && hasCopy;

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-foreground truncate">{job.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {[job.location, doneDate].filter(Boolean).join(' · ') || job.clientName}
          </p>
        </div>
        <StatusPill status={status} showcaseReady={showcaseReady} />
      </div>

      {/* Photos */}
      <div className="px-4 space-y-3">
        <PhotoGroup
          label="Before"
          hint="From your site-visit wrap-up"
          images={beforeImages}
          signedUrls={signedUrls}
          onOpen={(id) => onOpenPhoto(lightboxIndexOf(id))}
          onDelete={deleteQuoteAttachment}
          onAdd={() => beforeInputRef.current?.click()}
          onDropFiles={(files) => void handleFiles(files, 'before_photo')}
          emptyText="No before photos yet"
        />
        <PhotoGroup
          label="After"
          hint="The finished result"
          images={afterImages}
          signedUrls={signedUrls}
          onOpen={(id) => onOpenPhoto(lightboxIndexOf(id))}
          onDelete={deleteQuoteAttachment}
          onAdd={() => afterInputRef.current?.click()}
          onDropFiles={(files) => void handleFiles(files, 'after_photo')}
          addPrimary
          emptyText="Add after photos to showcase this job"
        />
        <PhotoGroup
          label="Progress"
          hint="Work in progress (optional)"
          images={processImages}
          signedUrls={signedUrls}
          onOpen={(id) => onOpenPhoto(lightboxIndexOf(id))}
          onDelete={deleteQuoteAttachment}
          onAdd={() => processInputRef.current?.click()}
          onDropFiles={(files) => void handleFiles(files, 'process_photo')}
          emptyText="Add progress photos (optional)"
        />
      </div>

      {/* Footer — opens the live preview where copy is drafted, edited with AI, and published. */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 mt-3 border-t border-border bg-muted/30">
        <p className="text-[11px] text-muted-foreground leading-tight">
          {status === 'published'
            ? 'Published to your website. Push the painters-wanaka repo to deploy.'
            : hasAfter
              ? 'Preview the project page, edit the copy with AI, then publish.'
              : 'Add at least one after photo to draft the page.'}
        </p>
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          disabled={!hasAfter}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 min-h-[40px] text-sm font-medium transition active:translate-y-px disabled:opacity-50',
            status === 'published'
              ? 'border border-border bg-background hover:bg-muted'
              : 'bg-primary text-primary-foreground hover:bg-primary/80',
          )}
        >
          {status === 'published' ? <Globe size={15} /> : <Sparkles size={15} />}
          {status === 'published' ? 'View / update page' : 'Draft project page'}
        </button>
      </div>

      {/* Hidden inputs. No `capture` attr on purpose: on a phone the OS
          picker then offers Camera OR Photo Library (and allows multi-select
          from the library), instead of forcing a single live camera shot. */}
      <input
        ref={afterInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => onPick(e, 'after_photo')}
      />
      <input
        ref={beforeInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => onPick(e, 'before_photo')}
      />
      <input
        ref={processInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => onPick(e, 'process_photo')}
      />

      {uploading && (
        <div className="flex items-center gap-2 px-4 pb-3 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Uploading photos…
        </div>
      )}

      {previewOpen && (
        <ProjectPreviewSheet
          job={job}
          beforeImages={beforeImages}
          afterImages={afterImages}
          processImages={processImages}
          signedUrls={signedUrls}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </section>
  );
}

// ── A labelled grid of thumbnails + an add button ──────────────────────────

function PhotoGroup({
  label, hint, images, signedUrls, onOpen, onDelete, onAdd, onDropFiles, addPrimary, emptyText,
}: {
  label: string;
  hint: string;
  images: QuoteAttachment[];
  signedUrls: Record<string, string>;
  onOpen: (attachmentId: string) => void;
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onAdd: () => void;
  onDropFiles: (files: File[]) => void;
  addPrimary?: boolean;
  emptyText: string;
}) {
  // Drag-and-drop. Child elements (thumbnails, buttons) fire their own
  // dragenter/dragleave, so we count depth with a ref and only drop the
  // highlight when it returns to zero — the same anti-flicker trick the
  // job sheet's attachment drop zone uses.
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepth = useRef(0);

  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragOver(true);
  }
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); // required, or the drop event never fires
    e.dataTransfer.dropEffect = 'copy';
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    onDropFiles(Array.from(e.dataTransfer.files ?? []));
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'relative rounded-xl transition',
        isDragOver && 'ring-2 ring-primary ring-offset-2 ring-offset-card',
      )}
    >
      <div className="flex items-baseline justify-between mb-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}{images.length > 0 && <span className="ml-1 text-muted-foreground/70">({images.length})</span>}
        </p>
        <span className="text-[10px] text-muted-foreground/70">{hint}</span>
      </div>

      {images.length > 0 ? (
        <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
          {images.map((a) => (
            <PhotoThumb
              key={a.id}
              url={signedUrls[a.storagePath] ?? null}
              fileName={a.fileName ?? a.storagePath.split('/').pop() ?? 'photo'}
              onOpen={() => onOpen(a.id)}
              onDelete={() => onDelete(a.id)}
            />
          ))}
          <AddTile onClick={onAdd} primary={addPrimary} />
        </div>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-xl border border-dashed min-h-[64px] px-3 text-sm font-medium transition active:scale-[0.99]',
            addPrimary
              ? 'border-primary/40 bg-primary/5 text-primary hover:bg-primary/10'
              : 'border-border text-muted-foreground hover:bg-muted',
          )}
        >
          {addPrimary ? <Camera size={17} /> : <ImagePlus size={16} />}
          {emptyText}
        </button>
      )}

      {/* Always-visible hint so the drop affordance is discoverable without
          starting a drag. Desktop only — drag-and-drop isn't a thing on touch,
          where the tap-to-add buttons are already the path. */}
      <p className="hidden md:block mt-2 text-[10px] text-muted-foreground/60">
        {'Drag & drop photos here, or click to add'}
      </p>

      {/* Drop overlay — only while a file drag is hovering this zone. */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[1px]">
          <span className="text-sm font-semibold text-primary">
            Drop {label.toLowerCase()} photos here
          </span>
        </div>
      )}
    </div>
  );
}

function AddTile({ onClick, primary }: { onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Add photos"
      className={cn(
        'flex aspect-square items-center justify-center rounded-xl border border-dashed transition active:scale-[0.97]',
        primary
          ? 'border-primary/40 bg-primary/5 text-primary hover:bg-primary/10'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {primary ? <Camera size={20} /> : <ImagePlus size={18} />}
    </button>
  );
}

function StatusPill({ status, showcaseReady }: { status: string; showcaseReady: boolean }) {
  if (status === 'published') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
        <Globe size={12} /> Published
      </span>
    );
  }
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium',
      showcaseReady ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-muted text-muted-foreground',
    )}>
      <Images size={12} /> {showcaseReady ? 'Review' : 'Draft'}
    </span>
  );
}
