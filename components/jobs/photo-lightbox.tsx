'use client';

// ── Photo lightbox + thumbnail grid ────────────────────────────────────────
//
// A full-screen image viewer for the job's "Plans & photos" scope images.
// Tap a thumbnail to open; swipe (phone) or arrow-keys / on-screen arrows
// (desktop) to flick through every image on the job; Escape or a tap on the
// dark area closes it.
//
// Built on the same Base UI dialog primitive the rest of the app uses, so it
// stacks correctly *inside* the JobDetailSheet — Escape closes the lightbox
// first, leaving the sheet open underneath (the library handles the nesting).
//
// Signed URLs are minted by the caller (one batched request for the whole
// grid) and passed in, so opening the lightbox is instant — the full image
// is already cached from rendering the thumbnail.

import { useRef, useState } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { ChevronLeft, ChevronRight, X, ExternalLink, Loader2, ImageOff, Trash2, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

const IMAGE_EXTS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic', '.heif',
];

/** Does this filename look like a viewable image (vs a PDF or other doc)? */
export function isImageName(name: string): boolean {
  const n = name.toLowerCase();
  return IMAGE_EXTS.some((ext) => n.endsWith(ext));
}

export interface LightboxImage {
  id: string;
  fileName: string;
  /** Signed URL for the full image. `null` while the URL is still being signed. */
  signedUrl: string | null;
}

export function PhotoLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: LightboxImage[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  const touchStartX = useRef<number | null>(null);
  const multiTouch = useRef(false);

  const count = images.length;
  const current = images[index];
  const hasMultiple = count > 1;

  function go(delta: number) {
    if (count === 0) return;
    onIndexChange((index + delta + count) % count);
  }

  // Close only when the tap lands on the dark backdrop itself, not on the
  // image or a control.
  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!hasMultiple) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length > 1) { multiTouch.current = true; return; }
    multiTouch.current = false;
    touchStartX.current = e.touches[0].clientX;
  }
  function handleTouchEnd(e: React.TouchEvent) {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (multiTouch.current || start === null) return;
    const dx = e.changedTouches[0].clientX - start;
    if (Math.abs(dx) < 40) return;
    go(dx < 0 ? 1 : -1); // swipe left → next, swipe right → previous
  }

  if (!current) return null;

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[70] bg-black/90 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
        />
        <DialogPrimitive.Popup
          data-slot="photo-lightbox"
          onClick={handleBackdropClick}
          onKeyDown={handleKeyDown}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="fixed inset-0 z-[80] flex select-none items-center justify-center bg-black/90 outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
        >
          <DialogPrimitive.Title className="sr-only">Photo viewer</DialogPrimitive.Title>

          {/* Top bar: counter + filename, and a close button. */}
          <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pt-3 pb-10">
            <div className="min-w-0 flex-1">
              {hasMultiple && (
                <p className="text-xs font-semibold tabular-nums text-white/90">
                  {index + 1} / {count}
                </p>
              )}
              <p className="truncate text-sm text-white/70" title={current.fileName}>
                {current.fileName}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/30 shadow-lg backdrop-blur-sm transition hover:bg-black/80 active:scale-95"
            >
              <X size={22} strokeWidth={2} />
            </button>
          </div>

          {/* The image (or a spinner while its URL signs / it loads). */}
          {current.signedUrl ? (
            <img
              key={current.id}
              src={current.signedUrl}
              alt={current.fileName}
              draggable={false}
              className="max-h-[88vh] max-w-[92vw] object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-white/70">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-xs">Loading…</span>
            </div>
          )}

          {/* Previous / next — only when there's more than one image. */}
          {hasMultiple && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                aria-label="Previous photo"
                className="absolute left-2 sm:left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/30 shadow-lg backdrop-blur-sm transition hover:bg-black/80 active:scale-95"
              >
                <ChevronLeft size={26} strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                aria-label="Next photo"
                className="absolute right-2 sm:right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/30 shadow-lg backdrop-blur-sm transition hover:bg-black/80 active:scale-95"
              >
                <ChevronRight size={26} strokeWidth={2} />
              </button>
            </>
          )}

          {/* Open the full-resolution original in a new tab (zoom / save). */}
          {current.signedUrl && (
            <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-black/70 to-transparent px-4 pt-10 pb-4">
              <a
                href={current.signedUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 transition hover:bg-white/20"
              >
                <ExternalLink size={13} strokeWidth={2} />
                Open original
              </a>
            </div>
          )}

          {/* Preload the neighbours so flicking through feels instant. */}
          {hasMultiple && (
            <div className="hidden" aria-hidden>
              {[index - 1, index + 1].map((i) => {
                const n = images[(i + count) % count];
                return n?.signedUrl ? <img key={n.id} src={n.signedUrl} alt="" /> : null;
              })}
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ── Single thumbnail tile in the grid ──────────────────────────────────────
//
// A square, tappable image tile with a corner delete button. Tapping the
// tile opens the lightbox; tapping the corner deletes (with a confirm).

export function PhotoThumb({
  url,
  fileName,
  onOpen,
  onDelete,
  onMakeCover,
  isCover,
}: {
  url: string | null;
  fileName: string;
  onOpen: () => void;
  onDelete?: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Pin this photo as the job's main image (the thumbnail staff see).
   * Omit to hide the control — e.g. for non-owners. Called with `false`
   * when it's already the cover, meaning "unpin, go back to auto".
   */
  onMakeCover?: (makeCover: boolean) => void;
  /** True when this photo is currently the job's main image. */
  isCover?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onDelete) return;
    if (!confirm(`Delete ${fileName}? This can't be undone.`)) return;
    setDeleting(true);
    try {
      const result = await onDelete();
      if (!result.ok) alert(`Couldn't delete: ${result.error ?? 'unknown error'}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="relative aspect-square group">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${fileName}`}
        className={cn(
          'absolute inset-0 overflow-hidden rounded-xl bg-muted/60 transition active:scale-[0.98]',
          isCover && 'ring-2 ring-primary ring-offset-1',
        )}
      >
        {url && !errored && (
          <img
            src={url}
            alt={fileName}
            loading="lazy"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            className={cn(
              'h-full w-full object-cover transition-opacity duration-200',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
          />
        )}
        {(!url || (!loaded && !errored)) && (
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </span>
        )}
        {errored && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1.5 text-center">
            <ImageOff size={16} className="text-muted-foreground" />
            <span className="w-full truncate text-[9px] leading-tight text-muted-foreground">
              {fileName}
            </span>
          </span>
        )}
      </button>
      {/* Pin as the job's main image. The current cover stays visible;
          others reveal on hover/focus so the grid stays clean. */}
      {onMakeCover && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onMakeCover(!isCover); }}
          aria-label={isCover ? `${fileName} is the main image — tap to unpin` : `Make ${fileName} the main image`}
          title={isCover ? 'Main image' : 'Make main image'}
          className={cn(
            'absolute left-1 top-1 flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition active:scale-95',
            isCover
              ? 'bg-primary text-primary-foreground opacity-100'
              : 'bg-black/45 text-white/90 opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
        >
          <Star size={12} strokeWidth={2} fill={isCover ? 'currentColor' : 'none'} />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          aria-label={`Delete ${fileName}`}
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-sm transition hover:bg-red-500/80 active:scale-95"
        >
          {deleting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Trash2 size={12} strokeWidth={2} />
          )}
        </button>
      )}
    </div>
  );
}
