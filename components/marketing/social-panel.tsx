'use client';

// Social channel composer — one component, two platforms (Facebook +
// Instagram), each rendered as its own tab in the project preview sheet.
//
// Same job, same photos as the website page, reshaped for a feed: one AI pass
// writes a platform-flavoured caption (FB: shorter + link back; IG: shortest +
// hashtag block, no link), Brad edits it inline and picks photos by tapping
// them IN THE ORDER they should appear (numbered badges show the order), sees
// a faithful mock of the post, then hits "Post". Posting runs locally (sips
// converts the photos) and returns a permalink to check it landed.
//
// Drafting a caption needs no Meta setup (it's just AI) — only the actual
// post needs the tokens in .env.local (see lib/facebook-publish.ts and
// lib/instagram-publish.ts).

import { useMemo, useState } from 'react';
import { Poppins } from 'next/font/google';
import { supabase } from '@/lib/supabase/client';
import { useStore } from '@/lib/store';
import { TestimonialPanel } from './testimonial-panel';
import { labelPhoto, type PhotoLabel } from '@/lib/photo-badge';
import type { Job, JobMarketing, QuoteAttachment } from '@/lib/types';
import {
  Send, Sparkles, Loader2, Check, ExternalLink, Minus, Plus, RefreshCw, AlertCircle,
} from 'lucide-react';

// lucide dropped its brand glyphs (Facebook AND Instagram), so we draw our own
// camera outline rather than depend on icons that may not exist in this version.
function IgGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="17.2" cy="6.8" r="0.5" fill="currentColor" />
    </svg>
  );
}
import { cn } from '@/lib/utils';

const MAX_PHOTOS = 10;

// Brand font for the burned-in BEFORE/AFTER pills (same face as the
// testimonial card). next/font self-hosts at build; no runtime request.
const poppins = Poppins({ weight: ['600'], subsets: ['latin'], display: 'swap' });

/** Which pill (if any) a photo gets when "Label photos" is on. */
function labelForKind(kind: QuoteAttachment['kind']): PhotoLabel | null {
  if (kind === 'after_photo') return 'AFTER';
  if (kind === 'before_photo' || kind === 'scope_photo') return 'BEFORE';
  return null; // process shots + testimonial cards stay unlabelled
}

export type SocialPlatform = 'facebook' | 'instagram';

const PLATFORMS: Record<SocialPlatform, {
  label: string;
  accent: string;            // tailwind-safe inline colour
  account: string;           // shown in the post mock header
  captionPath: string;
  postPath: string;
  note?: string;             // platform-specific fine print
}> = {
  facebook: {
    label: 'Facebook',
    accent: '#1877F2',
    account: 'Lakeside Painting',
    captionPath: '/api/marketing/facebook-caption',
    postPath: '/api/marketing/facebook-post',
  },
  instagram: {
    label: 'Instagram',
    accent: '#E1306C',
    account: 'lakesidepaintingnz',
    captionPath: '/api/marketing/instagram-caption',
    postPath: '/api/marketing/instagram-post',
    note: 'Photos are auto-cropped to Instagram’s allowed shapes (square-ish to 4:5).',
  },
};

// Brand badge — lucide dropped its Facebook brand glyph, so we render our own;
// Instagram still has one, shown on its brand gradient.
function PlatformBadge({ platform, size = 28 }: { platform: SocialPlatform; size?: number }) {
  if (platform === 'facebook') {
    return (
      <span
        className="inline-flex items-center justify-center rounded-lg bg-[#1877F2] font-bold leading-none text-white"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
        aria-hidden
      >
        f
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg text-white"
      style={{
        width: size, height: size,
        background: 'linear-gradient(45deg, #F58529, #DD2A7B 55%, #8134AF)',
      }}
      aria-hidden
    >
      <IgGlyph size={Math.round(size * 0.62)} />
    </span>
  );
}

type ApiResp = {
  ok?: boolean;
  error?: string;
  caption?: string;
  text?: string;
  result?: { postId?: string; permalink?: string; photoCount?: number };
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

export function SocialPanel({
  platform, job, afterImages, beforeImages, processImages = [], testimonialImages = [],
  signedUrls, websiteDescription, websiteOverview, websiteServices,
}: {
  platform: SocialPlatform;
  job: Job;
  afterImages: QuoteAttachment[];
  beforeImages: QuoteAttachment[];
  processImages?: QuoteAttachment[];
  /** Generated testimonial cards (kind 'testimonial_image'; 0 or 1 expected). */
  testimonialImages?: QuoteAttachment[];
  signedUrls: Record<string, string>;
  websiteDescription: string;
  websiteOverview: string[];
  websiteServices: string[];
}) {
  const cfg = PLATFORMS[platform];
  const { getJobMarketing, saveJobMarketing, refresh, businessId } = useStore();
  const saved = getJobMarketing(job.id);
  const channel = platform === 'facebook' ? saved?.facebook : saved?.instagram;

  // Photo pool: the testimonial card leads (it's made to be photo 1), then
  // afters (hero first), then befores, then process shots. Brad picks any
  // mix in any order.
  const pool = useMemo(() => {
    const heroId = saved?.heroAfterId ?? saved?.heroAttachmentId;
    let afters = afterImages;
    if (heroId && afters.some((a) => a.id === heroId)) {
      afters = [afters.find((a) => a.id === heroId)!, ...afters.filter((a) => a.id !== heroId)];
    }
    return [...testimonialImages, ...afters, ...beforeImages, ...processImages];
  }, [afterImages, beforeImages, processImages, testimonialImages, saved?.heroAfterId, saved?.heroAttachmentId]);

  const groupOf = (a: QuoteAttachment) =>
    a.kind === 'testimonial_image' ? 'Review'
      : a.kind === 'after_photo' ? 'After'
        : a.kind === 'before_photo' ? 'Before'
          : 'Process';

  const [caption, setCaption] = useState(channel?.caption ?? '');
  // Selection order IS post order — first tap is photo 1 in the post.
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const savedIds = channel?.photoAttachmentIds?.filter((id) => pool.some((a) => a.id === id));
    if (savedIds && savedIds.length > 0) return savedIds.slice(0, MAX_PHOTOS);
    // Default: the best 4 afters (hero first); first 4 of anything if no afters.
    const afters = pool.filter((a) => a.kind === 'after_photo');
    return (afters.length > 0 ? afters : pool).slice(0, 4).map((a) => a.id);
  });

  const [generating, setGenerating] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);
  const [postedNow, setPostedNow] = useState<{ permalink?: string } | null>(null);
  // Burn BEFORE/AFTER pills onto before+after photos at post time. On by
  // default — the whole point of a before/after album is knowing which is which.
  const [labelPhotos, setLabelPhotos] = useState<boolean>(channel?.labelPhotos ?? true);

  // Post order = tap order. selectedIds is already in the order Brad tapped.
  const selected = selectedIds
    .map((id) => pool.find((a) => a.id === id))
    .filter((a): a is QuoteAttachment => Boolean(a));
  const orderedSelectedIds = selected.map((a) => a.id);

  const alreadyPosted = channel?.status === 'posted';
  const permalink = postedNow?.permalink ?? channel?.permalink;

  async function persist(nextCaption: string, nextIds: string[], nextLabel: boolean = labelPhotos) {
    const next = {
      ...channel,
      caption: nextCaption,
      photoAttachmentIds: nextIds,
      labelPhotos: nextLabel,
      status: channel?.status ?? 'draft',
    };
    const updates: Partial<Pick<JobMarketing, 'facebook' | 'instagram'>> =
      platform === 'facebook' ? { facebook: next } : { instagram: next };
    await saveJobMarketing(job.id, updates);
  }

  async function generate() {
    setGenerating(true);
    setPostErr(null);
    try {
      const { httpOk, body } = await authedPost(cfg.captionPath, {
        jobId: job.id,
        description: websiteDescription,
        overview: websiteOverview,
        services: websiteServices,
      });
      if (!httpOk || !body.caption) {
        setPostErr(body.error ?? 'Could not draft the caption — try again.');
        return;
      }
      setCaption(body.caption);
      void persist(body.caption, orderedSelectedIds);
    } finally {
      setGenerating(false);
    }
  }

  async function runAi(instruction: string) {
    if (!caption.trim()) return;
    setAiBusy(true);
    try {
      const { httpOk, body } = await authedPost('/api/marketing/rewrite', {
        text: caption,
        instruction,
        context: `${cfg.label} caption for a painting job in ${job.location ?? 'Wanaka'}. Keep the hashtags${platform === 'facebook' ? ' and any link' : '; never add a URL'}.`,
      });
      if (!httpOk || !body.text) {
        setPostErr(body.error ?? 'AI rewrite failed — try again.');
        return;
      }
      setCaption(body.text);
      void persist(body.text, orderedSelectedIds);
    } finally {
      setAiBusy(false);
    }
  }

  function togglePhoto(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_PHOTOS) return prev;
      return [...prev, id];
    });
  }

  // A freshly generated testimonial card jumps to photo 1 — that's the whole
  // point of making it. Persist the new order so a reopen matches.
  function handleTestimonialGenerated(id: string) {
    const nextIds = [id, ...orderedSelectedIds.filter((x) => x !== id)].slice(0, MAX_PHOTOS);
    setSelectedIds(nextIds);
    void persist(caption, nextIds);
  }

  /**
   * When labelling is on, composite BEFORE/AFTER pills onto the relevant
   * photos in the browser and upload the copies as TEMP storage objects.
   * Returns { attachmentId → temp storagePath } plus the temp paths for
   * cleanup. Originals in storage are never touched.
   */
  async function buildLabelledOverrides(): Promise<{
    overrides: Record<string, string>;
    tempPaths: string[];
  }> {
    const overrides: Record<string, string> = {};
    const tempPaths: string[] = [];
    if (!labelPhotos || !businessId) return { overrides, tempPaths };
    try {
      await document.fonts.load(`600 40px ${poppins.style.fontFamily}`);
    } catch { /* degrade to system sans */ }
    for (const att of selected) {
      const label = labelForKind(att.kind);
      const url = signedUrls[att.storagePath];
      if (!label || !url) continue;
      const blob = await labelPhoto(url, label, poppins.style.fontFamily);
      const tempPath = `${businessId}/social-labelled/${crypto.randomUUID()}.jpg`;
      const { error } = await supabase.storage
        .from('quote-attachments')
        .upload(tempPath, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error(`Couldn't stage the labelled "${label}" photo: ${error.message}`);
      overrides[att.id] = tempPath;
      tempPaths.push(tempPath);
    }
    return { overrides, tempPaths };
  }

  async function post() {
    setPostErr(null);
    setPostedNow(null);
    if (!caption.trim() || orderedSelectedIds.length === 0) return;
    // Persist exactly what's on screen first, so a reopen matches and the post
    // uses the reviewed copy.
    await persist(caption, orderedSelectedIds);
    setPosting(true);
    let tempPaths: string[] = [];
    try {
      let overrides: Record<string, string> = {};
      try {
        ({ overrides, tempPaths } = await buildLabelledOverrides());
      } catch (e) {
        setPostErr(e instanceof Error ? e.message : 'Labelling the photos failed.');
        return;
      }
      const { httpOk, body } = await authedPost(cfg.postPath, {
        jobId: job.id,
        caption,
        photoAttachmentIds: orderedSelectedIds,
        photoOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
      if (!httpOk || body.ok === false) {
        setPostErr(body.error ?? 'Posting failed — check the dev-server console.');
        return;
      }
      setPostedNow({ permalink: body.result?.permalink });
      await refresh();
    } finally {
      // The temp labelled copies have served their purpose either way.
      if (tempPaths.length > 0) {
        void supabase.storage.from('quote-attachments').remove(tempPaths).catch(() => {});
      }
      setPosting(false);
    }
  }

  const canPost = caption.trim().length > 0 && orderedSelectedIds.length > 0 && !posting;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <PlatformBadge platform={platform} size={28} />
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Post to {cfg.label}</h3>
          <p className="text-[11px] text-gray-500">Own caption, own photos — independent of the website page.</p>
        </div>
        {alreadyPosted && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-[11px] font-semibold text-green-700">
            <Check size={12} /> Posted
          </span>
        )}
      </div>

      {/* Testimonial card maker — Facebook tab only (the generated image
          shows up in BOTH platforms' photo pools once created). */}
      {platform === 'facebook' && (
        <div className="mb-4">
          <TestimonialPanel
            job={job}
            existing={testimonialImages}
            signedUrls={signedUrls}
            accent={cfg.accent}
            onGenerated={handleTestimonialGenerated}
          />
        </div>
      )}

      {caption.trim().length === 0 ? (
        // Empty state — one button to draft the caption from the page copy.
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center gap-2 rounded-lg px-4 min-h-[44px] text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: cfg.accent }}
        >
          {generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          {generating ? 'Writing the caption…' : `Draft ${cfg.label} caption`}
        </button>
      ) : (
        <div className="space-y-4">
          {/* Editor: caption + AI buttons */}
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium text-gray-500">Caption</span>
              {aiBusy ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-500"><Loader2 size={12} className="animate-spin" /> Writing…</span>
              ) : (
                <>
                  <CapBtn icon={Minus} label="Shorter" onClick={() => runAi(`Make this ${cfg.label} caption a bit shorter and punchier, keeping the hashtags.`)} />
                  <CapBtn icon={Sparkles} label="Rewrite" onClick={() => runAi(`Rewrite this ${cfg.label} caption to read more naturally, keeping the same facts and hashtags.`)} />
                  <CapBtn icon={Plus} label="Longer" onClick={() => runAi(`Add a little more warmth/detail to this ${cfg.label} caption, keeping the same facts and hashtags.`)} />
                  <CapBtn icon={RefreshCw} label="Regenerate" onClick={generate} />
                </>
              )}
            </div>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => void persist(caption, orderedSelectedIds)}
              rows={5}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-[15px] leading-relaxed text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 resize-y"
            />
          </div>

          {/* Photo picker — tap in the order they should appear in the post. */}
          {pool.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium text-gray-500">
                  Photos ({selected.length} of {pool.length}
                  {pool.length > MAX_PHOTOS ? `, max ${MAX_PHOTOS}` : ''}) — tap in the order you want them
                </p>
                {selected.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    className="rounded-full px-2 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-gray-100"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {pool.map((a) => {
                  const url = signedUrls[a.storagePath] ?? null;
                  const order = orderedSelectedIds.indexOf(a.id);
                  const on = order >= 0;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => togglePhoto(a.id)}
                      aria-label={on ? `Photo ${order + 1} — tap to remove` : 'Tap to add photo'}
                      className={cn(
                        'relative aspect-square w-full overflow-hidden rounded-lg bg-gray-100 ring-2 transition',
                        on ? 'opacity-100' : 'ring-transparent opacity-60 hover:opacity-100',
                      )}
                      style={on ? ({ '--tw-ring-color': cfg.accent } as React.CSSProperties) : undefined}
                    >
                      {url
                        ? <img src={url} alt="" className="h-full w-full object-cover" />
                        : <span className="flex h-full items-center justify-center"><Loader2 size={12} className="animate-spin text-gray-400" /></span>}
                      <span className="absolute left-1 bottom-1 rounded bg-black/55 px-1 py-px text-[9px] font-medium text-white">
                        {groupOf(a)}
                      </span>
                      {on && (
                        <span
                          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white shadow"
                          style={{ backgroundColor: cfg.accent }}
                        >
                          {order + 1}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-gray-400">
                The numbers are the order they&apos;ll appear in the post. Tap a selected photo to remove it.
                {cfg.note ? ` ${cfg.note}` : ''}
              </p>
              {/* Burn-in labels — only offered when the selection has photos to label. */}
              {selected.some((a) => labelForKind(a.kind) !== null) && (
                <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 rounded-lg px-1 py-1.5 text-[13px] font-medium text-gray-700">
                  <input
                    type="checkbox"
                    checked={labelPhotos}
                    onChange={(e) => {
                      setLabelPhotos(e.target.checked);
                      void persist(caption, orderedSelectedIds, e.target.checked);
                    }}
                    className="h-4.5 w-4.5 accent-current"
                    style={{ accentColor: cfg.accent }}
                  />
                  Add <span className="rounded-full bg-gray-900/70 px-2 py-0.5 text-[10px] font-semibold tracking-widest text-white">BEFORE</span>
                  /
                  <span className="rounded-full bg-gray-900/70 px-2 py-0.5 text-[10px] font-semibold tracking-widest text-white">AFTER</span>
                  tags to the photos
                </label>
              )}
            </div>
          )}

          {/* Live mock of the actual post */}
          {platform === 'facebook'
            ? <FacebookMock caption={caption} photos={selected} signedUrls={signedUrls} labelOf={labelPhotos ? (a) => labelForKind(a.kind) : undefined} />
            : <InstagramMock caption={caption} photos={selected} signedUrls={signedUrls} account={cfg.account} labelOf={labelPhotos ? (a) => labelForKind(a.kind) : undefined} />}
        </div>
      )}

      {/* Result / error */}
      {postedNow && (
        <p className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-green-700">
          <Check size={14} /> Posted to {cfg.label}.
          {permalink && (
            <a href={permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
              View post <ExternalLink size={12} />
            </a>
          )}
        </p>
      )}
      {alreadyPosted && !postedNow && permalink && (
        <p className="mt-3 text-[12px] text-gray-500">
          Already posted —{' '}
          <a href={permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
            view on {cfg.label} <ExternalLink size={12} />
          </a>. Posting again creates a new post.
        </p>
      )}
      {postErr && (
        <p className="mt-3 flex items-start gap-1.5 text-[12px] text-red-600 leading-snug">
          <AlertCircle size={14} className="mt-px shrink-0" /> {postErr}
        </p>
      )}

      {/* Post button */}
      {caption.trim().length > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-400 leading-tight">
            Posts from your Mac. After it goes up, open {cfg.label} to check it.
          </p>
          <button
            type="button"
            onClick={post}
            disabled={!canPost}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 min-h-[44px] text-sm font-semibold text-white transition hover:opacity-90 active:translate-y-px disabled:opacity-50"
            style={{ backgroundColor: cfg.accent }}
          >
            {posting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {posting ? 'Posting…' : alreadyPosted ? 'Post again' : `Post to ${cfg.label}`}
          </button>
        </div>
      )}
    </div>
  );
}

function CapBtn({ icon: Icon, label, onClick }: { icon: typeof Sparkles; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-100"
    >
      <Icon size={12} /> <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

// A small mock of the burned-in pill, matching lib/photo-badge.ts's design.
function MockPill({ label }: { label: string }) {
  return (
    <span className="absolute left-1.5 top-1.5 rounded-full bg-gray-900/70 px-2 py-0.5 text-[9px] font-semibold tracking-widest text-white">
      {label}
    </span>
  );
}

// A faithful-ish render of the Facebook post: page header, caption, photo grid.
function FacebookMock({
  caption, photos, signedUrls, labelOf,
}: {
  caption: string;
  photos: QuoteAttachment[];
  signedUrls: Record<string, string>;
  labelOf?: (a: QuoteAttachment) => string | null;
}) {
  const shown = photos.slice(0, 4);
  const extra = photos.length - shown.length;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2.5 p-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#1877F2] text-[12px] font-bold text-white">LP</span>
        <div className="leading-tight">
          <p className="text-[13px] font-semibold text-gray-900">Lakeside Painting</p>
          <p className="text-[11px] text-gray-500">Just now · 🌐</p>
        </div>
      </div>
      {caption.trim() && (
        <p className="whitespace-pre-wrap px-3 pb-3 text-[14px] leading-relaxed text-gray-900">{caption}</p>
      )}
      {shown.length > 0 && (
        <div className={cn('grid gap-0.5', shown.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
          {shown.map((a, i) => {
            const url = signedUrls[a.storagePath] ?? null;
            const isLast = i === shown.length - 1;
            return (
              <div key={a.id} className={cn('relative bg-gray-100', shown.length === 3 && i === 0 ? 'col-span-2 aspect-[2/1]' : 'aspect-square')}>
                {url
                  ? <img src={url} alt="" className="h-full w-full object-cover" />
                  : <span className="flex h-full items-center justify-center text-gray-300"><Loader2 size={16} className="animate-spin" /></span>}
                {labelOf?.(a) && <MockPill label={labelOf(a)!} />}
                {isLast && extra > 0 && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white">+{extra}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// A faithful-ish render of the Instagram post: username header, big square
// first photo (with carousel counter), then the caption below it IG-style.
function InstagramMock({
  caption, photos, signedUrls, account, labelOf,
}: {
  caption: string;
  photos: QuoteAttachment[];
  signedUrls: Record<string, string>;
  account: string;
  labelOf?: (a: QuoteAttachment) => string | null;
}) {
  const first = photos[0];
  const url = first ? (signedUrls[first.storagePath] ?? null) : null;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2.5 p-3">
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white"
          style={{ background: 'linear-gradient(45deg, #F58529, #DD2A7B 55%, #8134AF)' }}
        >
          LP
        </span>
        <p className="text-[13px] font-semibold text-gray-900">{account}</p>
      </div>
      {first && (
        <div className="relative aspect-square bg-gray-100">
          {url
            ? <img src={url} alt="" className="h-full w-full object-cover" />
            : <span className="flex h-full items-center justify-center text-gray-300"><Loader2 size={16} className="animate-spin" /></span>}
          {first && labelOf?.(first) && <MockPill label={labelOf(first)!} />}
          {photos.length > 1 && (
            <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
              1/{photos.length}
            </span>
          )}
        </div>
      )}
      {caption.trim() && (
        <p className="whitespace-pre-wrap px-3 py-3 text-[13px] leading-relaxed text-gray-900">
          <span className="font-semibold">{account}</span> {caption}
        </p>
      )}
    </div>
  );
}
