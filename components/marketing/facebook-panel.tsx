'use client';

// Facebook channel — lives at the bottom of the project preview sheet.
//
// Same job, same photos as the website page, reshaped for a feed: one AI pass
// writes a Facebook-flavoured caption (shorter, hashtags, link back), Brad edits
// it inline and picks which photos go in, sees a faithful mock of the post, then
// hits "Post to Facebook". Posting runs locally (sips converts the photos) and
// returns a permalink so he can open Facebook and check it landed.
//
// Drafting a caption needs no Facebook setup (it's just AI) — only the actual
// post needs FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN in .env.local.

import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useStore } from '@/lib/store';
import type { Job, QuoteAttachment } from '@/lib/types';
import {
  Send, Sparkles, Loader2, Check, ExternalLink, Minus, Plus, RefreshCw, AlertCircle,
} from 'lucide-react';

// Brand-blue "f" badge — lucide dropped its Facebook brand glyph, so we render
// our own rather than depend on an icon that may not exist in this version.
function FbBadge({ size = 28 }: { size?: number }) {
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
import { cn } from '@/lib/utils';

const MAX_PHOTOS = 10;

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

export function FacebookPanel({
  job, afterImages, beforeImages, signedUrls,
  websiteDescription, websiteOverview, websiteServices,
}: {
  job: Job;
  afterImages: QuoteAttachment[];
  beforeImages: QuoteAttachment[];
  signedUrls: Record<string, string>;
  websiteDescription: string;
  websiteOverview: string[];
  websiteServices: string[];
}) {
  const { getJobMarketing, saveJobMarketing, refresh } = useStore();
  const saved = getJobMarketing(job.id);
  const fb = saved?.facebook;

  // Photo pool: after photos lead (the finished result is the headline); fall
  // back to before photos only when there are no afters. Hero after-photo first.
  const pool = useMemo(() => {
    const base = afterImages.length > 0 ? afterImages : beforeImages;
    const heroId = saved?.heroAfterId ?? saved?.heroAttachmentId;
    if (heroId && base.some((a) => a.id === heroId)) {
      return [base.find((a) => a.id === heroId)!, ...base.filter((a) => a.id !== heroId)];
    }
    return base;
  }, [afterImages, beforeImages, saved?.heroAfterId, saved?.heroAttachmentId]);

  const [caption, setCaption] = useState(fb?.caption ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const savedIds = fb?.photoAttachmentIds?.filter((id) => pool.some((a) => a.id === id));
    return (savedIds && savedIds.length > 0 ? savedIds : pool.map((a) => a.id)).slice(0, MAX_PHOTOS);
  });

  const [generating, setGenerating] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);
  const [postedNow, setPostedNow] = useState<{ permalink?: string } | null>(null);

  const selected = pool.filter((a) => selectedIds.includes(a.id));
  // Keep the post order stable to the pool order.
  const orderedSelectedIds = pool.filter((a) => selectedIds.includes(a.id)).map((a) => a.id);

  const alreadyPosted = fb?.status === 'posted';
  const permalink = postedNow?.permalink ?? fb?.permalink;

  async function persist(nextCaption: string, nextIds: string[]) {
    await saveJobMarketing(job.id, {
      facebook: {
        ...fb,
        caption: nextCaption,
        photoAttachmentIds: nextIds,
        status: fb?.status ?? 'draft',
      },
    });
  }

  async function generate() {
    setGenerating(true);
    setPostErr(null);
    try {
      const { httpOk, body } = await authedPost('/api/marketing/facebook-caption', {
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
        context: `Facebook caption for a painting job in ${job.location ?? 'Wanaka'}. Keep hashtags and any link.`,
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

  async function post() {
    setPostErr(null);
    setPostedNow(null);
    if (!caption.trim() || orderedSelectedIds.length === 0) return;
    // Persist exactly what's on screen first, so a reopen matches and the post
    // uses the reviewed copy.
    await persist(caption, orderedSelectedIds);
    setPosting(true);
    try {
      const { httpOk, body } = await authedPost('/api/marketing/facebook-post', {
        jobId: job.id,
        caption,
        photoAttachmentIds: orderedSelectedIds,
      });
      if (!httpOk || body.ok === false) {
        setPostErr(body.error ?? 'Posting failed — check the dev-server console.');
        return;
      }
      setPostedNow({ permalink: body.result?.permalink });
      await refresh();
    } finally {
      setPosting(false);
    }
  }

  const canPost = caption.trim().length > 0 && orderedSelectedIds.length > 0 && !posting;

  return (
    <div className="mt-10 border-t border-gray-200 pt-6">
      <div className="mb-3 flex items-center gap-2">
        <FbBadge size={28} />
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Post to Facebook</h3>
          <p className="text-[11px] text-gray-500">Same job, reshaped for your Page feed.</p>
        </div>
        {alreadyPosted && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-[11px] font-semibold text-green-700">
            <Check size={12} /> Posted
          </span>
        )}
      </div>

      {caption.trim().length === 0 ? (
        // Empty state — one button to draft the caption from the page copy.
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center gap-2 rounded-lg bg-[#1877F2] px-4 min-h-[44px] text-sm font-medium text-white transition hover:bg-[#1877F2]/90 disabled:opacity-50"
        >
          {generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          {generating ? 'Writing the caption…' : 'Draft Facebook caption'}
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
                  <CapBtn icon={Minus} label="Shorter" onClick={() => runAi('Make this Facebook caption a bit shorter and punchier, keeping the hashtags and any link.')} />
                  <CapBtn icon={Sparkles} label="Rewrite" onClick={() => runAi('Rewrite this Facebook caption to read more naturally, keeping the same facts, hashtags and any link.')} />
                  <CapBtn icon={Plus} label="Longer" onClick={() => runAi('Add a little more warmth/detail to this Facebook caption, keeping the same facts, hashtags and any link.')} />
                  <CapBtn icon={RefreshCw} label="Regenerate" onClick={generate} />
                </>
              )}
            </div>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => void persist(caption, orderedSelectedIds)}
              rows={5}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-[15px] leading-relaxed text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-[#1877F2]/30 resize-y"
            />
          </div>

          {/* Photo picker */}
          {pool.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium text-gray-500">
                Photos ({selected.length} selected{pool.length > MAX_PHOTOS ? `, max ${MAX_PHOTOS}` : ''}) — tap to include
              </p>
              <div className="flex flex-wrap gap-2">
                {pool.map((a) => {
                  const url = signedUrls[a.storagePath] ?? null;
                  const on = selectedIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => togglePhoto(a.id)}
                      className={cn(
                        'relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-gray-100 ring-2 transition',
                        on ? 'ring-[#1877F2]' : 'ring-transparent opacity-60 hover:opacity-100',
                      )}
                    >
                      {url
                        ? <img src={url} alt="" className="h-full w-full object-cover" />
                        : <span className="flex h-full items-center justify-center"><Loader2 size={12} className="animate-spin text-gray-400" /></span>}
                      {on && (
                        <span className="absolute right-0.5 top-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#1877F2] text-white">
                          <Check size={11} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Live mock of the actual post */}
          <FacebookMock caption={caption} photos={selected} signedUrls={signedUrls} />
        </div>
      )}

      {/* Result / error */}
      {postedNow && (
        <p className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-green-700">
          <Check size={14} /> Posted to your Facebook Page.
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
            view on Facebook <ExternalLink size={12} />
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
            Posts from your Mac. After it goes up, open Facebook to check it.
          </p>
          <button
            type="button"
            onClick={post}
            disabled={!canPost}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#1877F2] px-4 min-h-[44px] text-sm font-semibold text-white transition hover:bg-[#1877F2]/90 active:translate-y-px disabled:opacity-50"
          >
            {posting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {posting ? 'Posting…' : alreadyPosted ? 'Post again' : 'Post to Facebook'}
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

// A faithful-ish render of the Facebook post: page header, caption, photo grid.
function FacebookMock({
  caption, photos, signedUrls,
}: {
  caption: string;
  photos: QuoteAttachment[];
  signedUrls: Record<string, string>;
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
