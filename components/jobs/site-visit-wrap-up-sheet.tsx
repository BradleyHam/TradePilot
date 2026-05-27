'use client';

// Site Visit Wrap-Up — the "I just walked the property, capture
// everything while it's fresh" sheet.
//
// Opens when Brad ticks a quote_visit schedule item that has a linked
// job. Single screen, single save. Optimised for the 30 seconds Brad
// has between walking back to the van and turning the key.
//
// What it captures, by intent:
//
//   1. Photos — the scope-of-work evidence. Uses the existing
//      addQuoteAttachments + ensureJobHasQuote pipeline so this slots
//      into the same flow as the JobDetailSheet's Plans & Photos panel.
//      Photos are classified as 'scope_photo' kind (vs. before / after).
//
//   2. Work type + prep level + surface area — the structured fields
//      Tier-2's quoting AI will use as "what kind of job is this?"
//      input. Already on the Job model from migration 003-era; we're
//      just surfacing them at the right moment.
//
//   3. Access notes — chips. Drives whether scaffold/lift is needed,
//      which materially changes the price. The chip vocabulary lives
//      here in the component so it can evolve without a migration.
//
//   4. Scope notes — the rambled free-text capture. The brain dump.
//      Future feature: voice-to-text fills this in. For now, text.
//
//   5. Quote-ready-by date — the promise to the customer. Drives the
//      "quote owed" surface on Home later. Defaults to 2 days out.
//
// What we DON'T do here on purpose:
//   - Build the actual quote. That's a separate flow (Tier 2). The
//     wrap-up is *input* to that, not the output.
//   - Change the job's status. Stays at lead/quoted. Status change
//     happens when the quote is sent.
//   - Force any field. Everything's optional — a tired painter who
//     just wants to tick "done" can leave all fields empty, save, move
//     on. We just preserve whatever they DID capture.

import { useState, useEffect, useMemo, useRef } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useStore } from '@/lib/store';
import { Job, WorkType, PrepLevel, QuoteAttachmentKind } from '@/lib/types';
import { Camera, X, MapPin, CalendarClock, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

// All chip vocabularies in this file are stored as text[] in Postgres
// and read back as string[] in TypeScript. Free-form strings on
// purpose — adding a new chip is a one-line change here, no schema
// migration needed. Order in each list matters: most-common chips
// first so they're cheapest to tap.

// Site-access chips — the physical realities that affect HOW Brad
// gets paint onto the wall. Most of these are price-relevant
// (scaffold ~doubles labour vs. ladder).
const ACCESS_CHIPS: { value: string; label: string }[] = [
  { value: 'ladder-ok',         label: 'Ladder OK'        },
  { value: 'scaffold-needed',   label: 'Scaffold'         },
  { value: 'cherry-picker',     label: 'Cherry picker'    },
  { value: 'second-storey',     label: '2nd storey'       },
  { value: 'tight-driveway',    label: 'Tight driveway'   },
  { value: 'no-off-street-park', label: 'No off-street parking' },
  { value: 'pets-on-site',      label: 'Pets on site'     },
  { value: 'occupied',          label: 'Occupied home'    },
  { value: 'tenants',           label: 'Tenanted'         },
];

const WORK_TYPES: { value: WorkType; label: string }[] = [
  { value: 'exterior',  label: 'Exterior'  },
  { value: 'interior',  label: 'Interior'  },
  { value: 'cedar',     label: 'Cedar'     },
  { value: 'roof',      label: 'Roof'      },
  { value: 'wallpaper', label: 'Wallpaper' },
  { value: 'mixed',     label: 'Mixed'     },
];

const PREP_LEVELS: { value: PrepLevel; label: string; hint: string }[] = [
  { value: 'light',       label: 'Light',       hint: 'wash + spot-fill' },
  { value: 'medium',      label: 'Medium',      hint: 'sand, fill, prime' },
  { value: 'heavy',       label: 'Heavy',       hint: 'strip-back areas, full prime' },
  { value: 'full-strip',  label: 'Full strip',  hint: 'back to bare timber' },
];

// Add-on items — easy to forget, expensive to skip. If Brad ticks
// 'soffits' here but doesn't include them in the quote, he's giving
// away a half-day of work. The chips force the question to be asked
// explicitly at the site visit rather than discovered when the
// customer says "...and you'll do the soffits too, right?" two
// weeks later.
const ADDON_CHIPS: { value: string; label: string }[] = [
  { value: 'soffits',         label: 'Soffits'        },
  { value: 'fascia',          label: 'Fascia'         },
  { value: 'window-frames',   label: 'Window frames'  },
  { value: 'door-frames',     label: 'Door frames'    },
  { value: 'decking',         label: 'Decking'        },
  { value: 'handrails',       label: 'Handrails'      },
  { value: 'pergola',         label: 'Pergola'        },
  { value: 'pergola-posts',   label: 'Pergola posts'  },
  { value: 'gates',           label: 'Gates'          },
  { value: 'garage-doors',    label: 'Garage doors'   },
  { value: 'retaining-walls', label: 'Retaining walls' },
];

// Site logistics — practical realities for crew planning. Knowing
// there's no off-street parking changes whether Brad can park the
// van near the work; no power means battery sander only; pets mean
// he can't leave doors open. Each chip changes how the job runs.
const SITE_LOGISTICS_CHIPS: { value: string; label: string }[] = [
  { value: 'off-street-parking', label: 'Off-street parking' },
  { value: 'water-available',    label: 'Water tap on site'  },
  { value: 'power-for-sander',   label: 'Power available'    },
  { value: 'restricted-hours',   label: 'Restricted hours'   },
  { value: 'children-on-site',   label: 'Kids on site'       },
  { value: 'rural-driveway',     label: 'Rural/long driveway' },
  { value: 'no-onsite-toilet',   label: 'No toilet on site'  },
  { value: 'wind-exposed',       label: 'Wind exposed'       },
];

// Commercial signals — the soft factors that move quote pricing
// without changing the cost basis. A referred customer who's "been
// thinking about this for a while" and lives in a well-kept house
// is a different commercial situation than someone who said
// "what's your cheapest price?" Both get a quote; they shouldn't
// get the same number.
const COMMERCIAL_CHIPS: { value: string; label: string }[] = [
  { value: 'referral',                 label: 'Referral'              },
  { value: 'repeat-customer',          label: 'Repeat customer'       },
  { value: 'mentioned-budget',         label: 'Mentioned a budget'    },
  { value: 'price-shopping',           label: 'Getting multiple quotes' },
  { value: 'urgent',                   label: 'Urgent timeframe'      },
  { value: 'not-a-rush',               label: 'No rush'               },
  { value: 'decision-maker-present',   label: 'Decision-maker met'    },
  { value: 'cares-about-quality',      label: 'Quality-focused'       },
  { value: 'high-trust-vibe',          label: 'High trust / friendly' },
  { value: 'difficult-vibe',           label: 'Difficult vibe'        },
];

/**
 * Two ways the wrap-up can open:
 *
 *   1. `existing-job` — the visit already has a linked Job row. We patch
 *      it on save. Most common path for visits that were booked via the
 *      Leads page (which always links a job).
 *
 *   2. `create-from-visit` — the visit isn't linked to any job yet (e.g.
 *      a one-off site visit added directly on the Schedule page). On
 *      save we create a fresh Job row from the visit's title, link it,
 *      and attach photos/scope to it. Keeps the flow one-tap: tick the
 *      visit → wrap up → quote-ready job appears in the Jobs list.
 */
export type WrapUpTarget =
  | { mode: 'existing-job'; job: Job }
  | {
      mode: 'create-from-visit';
      /** Used as the new job's name (fallback: 'Site visit'). */
      visitTitle: string;
      /** Used as the new job's clientName (fallback: 'New lead'). */
      visitNotes?: string;
    };

interface SiteVisitWrapUpSheetProps {
  open: boolean;
  /** What the wrap-up is for. null = sheet stays closed regardless of `open`. */
  target: WrapUpTarget | null;
  /**
   * Called after a successful save. The parent uses this to complete
   * the underlying schedule_item. Receives the resolved jobId (either
   * the pre-existing one or the just-created one) so the parent can
   * patch the schedule_item's jobId if it was previously null.
   */
  onSaved: (jobId: string) => void;
  /** Called when the user dismisses without saving. */
  onCancel: () => void;
}

export function SiteVisitWrapUpSheet({
  open, target, onSaved, onCancel,
}: SiteVisitWrapUpSheetProps) {
  const {
    updateJob, addJob, addQuoteAttachments, ensureJobHasQuote, businessId,
  } = useStore();

  // Convenience: the existing-job shortcut, undefined in create mode.
  const job = target?.mode === 'existing-job' ? target.job : undefined;

  // ── Form state ───────────────────────────────────────────────────────
  // Initialised from the job's existing fields when the sheet opens, so
  // re-opening the wrap-up after a previous save reflects the saved state.
  // Reset whenever `open` flips true with a different job id.
  const [workType, setWorkType] = useState<WorkType | ''>('');
  const [prepLevel, setPrepLevel] = useState<PrepLevel | ''>('');
  const [surfaceAreaM2, setSurfaceAreaM2] = useState('');
  const [accessChips, setAccessChips] = useState<Set<string>>(new Set());
  const [scopeNotes, setScopeNotes] = useState('');
  const [quoteReadyBy, setQuoteReadyBy] = useState('');

  // New structured-data fields — feed Tier-2 quote drafting. Numbers
  // kept as strings in form state so empty / partial input works
  // cleanly; parsed on save. Sets used for chip multi-selects
  // mirroring the accessChips pattern above.
  const [coatsCount, setCoatsCount] = useState<'' | '1' | '2' | '3'>('');
  const [stainProduct, setStainProduct] = useState('');
  const [windowDoorCount, setWindowDoorCount] = useState('');
  const [daysEstimate, setDaysEstimate] = useState('');
  const [addonChips, setAddonChips] = useState<Set<string>>(new Set());
  const [siteLogisticsChips, setSiteLogisticsChips] = useState<Set<string>>(new Set());
  const [commercialChips, setCommercialChips] = useState<Set<string>>(new Set());

  // Staged photos: picked but not yet uploaded. We don't kick the upload
  // until Save so the user can remove ones they didn't mean to attach.
  const [stagedPhotos, setStagedPhotos] = useState<{ id: string; file: File }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // True while files are being dragged over the photo zone. Drives the
  // visual highlight so the user knows the zone is accepting the drop —
  // otherwise a dropped file just disappears with no feedback.
  const [dragActive, setDragActive] = useState(false);

  // Architectural plans — separate from photos because they're a
  // different attachment kind (kind='plan' vs 'scope_photo') and the
  // user thinks of them differently: photos are evidence, plans are
  // dimensions. Multiple PDFs allowed because an architect's package
  // often spans floor plan + elevations + site plan as separate files.
  const [stagedPlans, setStagedPlans] = useState<{ id: string; file: File }[]>([]);
  const planInputRef = useRef<HTMLInputElement>(null);
  const [planDragActive, setPlanDragActive] = useState(false);

  const [saving, setSaving] = useState(false);

  // Sensible default for quote-ready-by: 2 days from now. Customers
  // hear "I'll get the quote to you in a couple of days" and the app
  // should match that promise by default — Brad can shorten or extend.
  const defaultQuoteReadyBy = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  }, []);

  // Stable identity for what's being wrapped up. We hydrate the form
  // exactly once per "open for THIS target" — keyed by job id (for
  // existing-job mode) or visit title (for create-from-visit). Without
  // this stable key the effect would re-fire whenever the target object
  // reference changed (e.g. the parent recomputes it on a re-render
  // triggered by an unrelated store update), wiping out staged photos
  // and plans the user was in the middle of queueing.
  const targetKey = !target
    ? null
    : target.mode === 'existing-job'
      ? `job:${target.job.id}`
      : `visit:${target.visitTitle}`;

  // Hydrate the form when the sheet opens (or when the target changes
  // to a different visit/job). Two paths:
  //   - existing-job: pull current values off the Job row so repeated
  //     wrap-ups round-trip cleanly.
  //   - create-from-visit: start blank (and use the visit notes as a
  //     seed for scope text, since notes typed on the visit creation
  //     form usually capture "what the customer told me at the door").
  //
  // Deliberately NOT depending on `target` directly — only its stable
  // key — so an unrelated re-render that produces a new target object
  // (same underlying visit) doesn't reset the form.
  useEffect(() => {
    if (!open || !target) return;
    if (target.mode === 'existing-job') {
      const j = target.job;
      setWorkType(j.workType ?? '');
      setPrepLevel(j.prepLevel ?? '');
      setSurfaceAreaM2(j.surfaceAreaM2 ? String(j.surfaceAreaM2) : '');
      setAccessChips(new Set(j.accessNotes ?? []));
      setScopeNotes(j.scopeNotes ?? '');
      setQuoteReadyBy(j.quoteReadyBy ?? defaultQuoteReadyBy);
      // New structured fields. coatsCount widens 1-3 to the literal
      // union type our setter expects; anything else stored on legacy
      // rows falls back to empty.
      setCoatsCount(
        j.coatsCount === 1 || j.coatsCount === 2 || j.coatsCount === 3
          ? (String(j.coatsCount) as '1' | '2' | '3')
          : '',
      );
      setStainProduct(j.stainProduct ?? '');
      setWindowDoorCount(j.windowDoorCount != null ? String(j.windowDoorCount) : '');
      setDaysEstimate(j.daysEstimate != null ? String(j.daysEstimate) : '');
      setAddonChips(new Set(j.addonItems ?? []));
      setSiteLogisticsChips(new Set(j.siteLogistics ?? []));
      setCommercialChips(new Set(j.commercialSignals ?? []));
    } else {
      // create-from-visit
      setWorkType('');
      setPrepLevel('');
      setSurfaceAreaM2('');
      setAccessChips(new Set());
      setScopeNotes(target.visitNotes ?? '');
      setQuoteReadyBy(defaultQuoteReadyBy);
      setCoatsCount('');
      setStainProduct('');
      setWindowDoorCount('');
      setDaysEstimate('');
      setAddonChips(new Set());
      setSiteLogisticsChips(new Set());
      setCommercialChips(new Set());
    }
    setStagedPhotos([]);
    setStagedPlans([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey, defaultQuoteReadyBy]);

  function toggleAccessChip(value: string) {
    setAccessChips((prev) => toggleInSet(prev, value));
  }
  function toggleAddonChip(value: string) {
    setAddonChips((prev) => toggleInSet(prev, value));
  }
  function toggleSiteLogisticsChip(value: string) {
    setSiteLogisticsChips((prev) => toggleInSet(prev, value));
  }
  function toggleCommercialChip(value: string) {
    setCommercialChips((prev) => toggleInSet(prev, value));
  }
  // Pure helper — keeps the toggler functions above to a single line
  // each and avoids the mutate-then-return mistake (Set isn't immutable).
  function toggleInSet<T>(s: Set<T>, value: T): Set<T> {
    const next = new Set(s);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  /**
   * Add a batch of files to the staged list. Shared by the file-picker
   * input AND the drag-and-drop handler so both paths produce identical
   * results. Non-image files are silently dropped — we only want
   * photos in scope_photo attachments and a stray PDF being uploaded
   * as a "photo" would just confuse the quote builder later.
   */
  function addFilesToStaged(files: File[]) {
    const photos = files.filter((f) => f.type.startsWith('image/'));
    if (photos.length === 0) return;
    const next = photos.map((f) => ({
      id: `staged_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: f,
    }));
    setStagedPhotos((prev) => [...prev, ...next]);
  }

  function handlePickPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    addFilesToStaged(Array.from(e.target.files ?? []));
    // Reset so picking the same file twice re-fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeStagedPhoto(id: string) {
    setStagedPhotos((prev) => prev.filter((p) => p.id !== id));
  }

  // ── Drag-and-drop ────────────────────────────────────────────────────
  // Standard HTML5 DnD flow. preventDefault on dragOver is required or
  // the browser intercepts the drop and tries to open the files. We
  // gate the visual highlight on `dragActive` so the drop zone glows
  // only while a real drag is happening.
  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    // Some browsers fire dragOver more than dragEnter; ensure the
    // highlight stays on as long as we're being dragged over.
    if (!dragActive) setDragActive(true);
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    // Only turn off the highlight when we've actually left the zone,
    // not when we move over a child. relatedTarget is the element being
    // entered — if it's outside the drop zone, we're done.
    const rel = e.relatedTarget as Node | null;
    if (rel && (e.currentTarget as Node).contains(rel)) return;
    setDragActive(false);
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    addFilesToStaged(files);
  }

  // ── Plans (PDFs) ─────────────────────────────────────────────────────
  // Same shape as the photo helpers but filtered to PDFs only. Mixing
  // a stray .jpg into "plans" would mis-classify it as a `plan` kind
  // attachment downstream, polluting the m²-parser's input later.

  function addFilesToStagedPlans(files: File[]) {
    const pdfs = files.filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name),
    );
    if (pdfs.length === 0) return;
    const next = pdfs.map((f) => ({
      id: `staged_plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: f,
    }));
    setStagedPlans((prev) => [...prev, ...next]);
  }

  function handlePickPlans(e: React.ChangeEvent<HTMLInputElement>) {
    addFilesToStagedPlans(Array.from(e.target.files ?? []));
    if (planInputRef.current) planInputRef.current.value = '';
  }

  function removeStagedPlan(id: string) {
    setStagedPlans((prev) => prev.filter((p) => p.id !== id));
  }

  function handlePlanDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setPlanDragActive(true);
  }
  function handlePlanDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!planDragActive) setPlanDragActive(true);
  }
  function handlePlanDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const rel = e.relatedTarget as Node | null;
    if (rel && (e.currentTarget as Node).contains(rel)) return;
    setPlanDragActive(false);
  }
  function handlePlanDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setPlanDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    addFilesToStagedPlans(files);
  }

  async function handleSave() {
    if (!target) return;
    setSaving(true);
    try {
      // Shared payload of structured fields. Both branches below (patch
      // existing job vs. create new lead from visit) write the same
      // shape, so we build it once. Number fields parsed from form
      // strings here — empty inputs become undefined so we don't write
      // 0 / NaN into the DB.
      const structuredFields: Partial<Job> = {
        workType: (workType || undefined) as WorkType | undefined,
        prepLevel: (prepLevel || undefined) as PrepLevel | undefined,
        surfaceAreaM2: surfaceAreaM2 ? parseFloat(surfaceAreaM2) : undefined,
        accessNotes: Array.from(accessChips),
        scopeNotes: scopeNotes.trim() || undefined,
        quoteReadyBy: quoteReadyBy || undefined,
        coatsCount: coatsCount ? parseInt(coatsCount, 10) : undefined,
        stainProduct: stainProduct.trim() || undefined,
        windowDoorCount: windowDoorCount ? parseInt(windowDoorCount, 10) : undefined,
        daysEstimate: daysEstimate ? parseFloat(daysEstimate) : undefined,
        addonItems: Array.from(addonChips),
        siteLogistics: Array.from(siteLogisticsChips),
        commercialSignals: Array.from(commercialChips),
      };

      // Resolve the job: either patch the existing one, or create a
      // fresh lead row from the visit's title + scope notes.
      //
      // For create-from-visit we MUST await addJob — the downstream
      // chain (ensureJobHasQuote, addQuoteAttachments, the schedule
      // item's jobId update) all reference this job's id via FK in
      // Supabase. If we don't await, the inserts race ahead of the
      // job row landing and Postgres rejects with FK violations
      // (23503). For existing-job mode the job already exists so
      // updateJob is fine to fire-and-forget.
      let resolvedJobId: string;
      if (target.mode === 'existing-job') {
        resolvedJobId = target.job.id;
        updateJob(resolvedJobId, structuredFields);
      } else {
        // Guard: addJob with no businessId would silently fail in the
        // store and we'd just see "addJob failed" with no useful detail.
        // Catching it here gives the user a clearer message and avoids
        // a wasted Supabase round-trip.
        if (!businessId) {
          alert(
            "Couldn't save — no business context loaded yet. Try refreshing the page and saving again.",
          );
          return;
        }
        const newJobId = crypto.randomUUID();
        const now = new Date().toISOString();
        const persisted = await addJob({
          id: newJobId,
          businessId,
          // Title isn't perfect as a job name but it's the best signal
          // we have at this point (often it's the property address, e.g.
          // "Jac's ensuite", which is fine). User can rename later.
          name: target.visitTitle || 'Site visit',
          // Without a separate client-name field on the visit, we use a
          // placeholder. The wrap-up doesn't capture a client name yet —
          // a future enhancement would add a quick "client name" field.
          clientName: 'New lead',
          status: 'lead',
          ...structuredFields,
          createdAt: now,
          updatedAt: now,
        });
        if (!persisted) {
          // addJob already logged the Supabase error and rolled back
          // the optimistic local row. Surface a clear message to the
          // user so they know to retry — and crucially, do NOT chain
          // ensureJobHasQuote / addQuoteAttachments / updateScheduleItem
          // onto a job that never persisted. That used to cascade into
          // unhelpful 23503 FK violations downstream.
          alert(
            'Could not save the job to Supabase. Your wrap-up data is preserved — try saving again.\n\n'
            + "If this keeps happening, check that the latest migrations have been applied in the Supabase SQL editor.",
          );
          return;
        }
        resolvedJobId = persisted.id;
      }

      // Upload any staged photos + plans. Both kinds go through the
      // same addQuoteAttachments pipeline — photos as 'scope_photo',
      // plans as 'plan' — so we batch them into a single call. One
      // ensureJobHasQuote round-trip, one upload call. Saves a network
      // hop vs. doing photos and plans separately.
      if (stagedPhotos.length > 0 || stagedPlans.length > 0) {
        const quoteId = await ensureJobHasQuote(resolvedJobId);
        if (quoteId) {
          const batch: { file: File; kind: QuoteAttachmentKind }[] = [
            ...stagedPhotos.map(({ file }) => ({
              file,
              kind: 'scope_photo' as QuoteAttachmentKind,
            })),
            ...stagedPlans.map(({ file }) => ({
              file,
              kind: 'plan' as QuoteAttachmentKind,
            })),
          ];
          await addQuoteAttachments(quoteId, batch);
        }
        // If quoteId is null, the user gets a soft failure — the job
        // patches still succeed, the files just didn't upload. Better
        // than blocking the whole save on a quote-creation hiccup.
      }

      // Let the parent finish (typically: complete the schedule_item
      // AND link it to the resolved job).
      onSaved(resolvedJobId);
    } finally {
      setSaving(false);
    }
  }

  if (!target) return null;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[92dvh] overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle>Site visit wrap-up</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4 pb-6">
          {/* Context strip — confirms what we're wrapping up. Shows job
              fields when there's an existing job, or a "creating a new
              lead" indicator when we'll mint one on save. */}
          <div className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
            {job ? (
              <>
                <p className="text-sm font-medium text-foreground">{job.name}</p>
                <p className="text-xs text-muted-foreground">{job.clientName}</p>
                {job.location && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <MapPin size={11} strokeWidth={1.8} /> {job.location}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">
                  {target?.mode === 'create-from-visit' ? target.visitTitle : 'Site visit'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Saving will create a new lead from this visit. You can rename it later.
                </p>
              </>
            )}
          </div>

          {/* Photos — first because it's the highest-friction action
              (camera permissions, picking from library) and we want it
              done before Brad's attention drifts to the text fields.
              The outer div is the drop zone (handles drag events) and
              also forwards the click to the file picker. The button
              inside is the visible affordance. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Photos
            </label>
            <div
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className={cn(
                'w-full min-h-[88px] rounded-xl border-2 border-dashed cursor-pointer transition-colors flex flex-col items-center justify-center gap-1 px-3 py-3 text-sm font-medium text-foreground',
                // Drag-active highlight — primary tint so the user
                // knows the drop will be accepted. We thicken the
                // border too so it reads as an active target rather
                // than a hover state.
                dragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-input bg-background hover:bg-accent',
              )}
            >
              <div className="flex items-center gap-2">
                <Camera size={16} strokeWidth={1.8} />
                {stagedPhotos.length === 0
                  ? 'Take, choose, or drop photos'
                  : `Add more (${stagedPhotos.length} so far)`}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Drag and drop multiple photos to add them at once.
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              // `capture="environment"` (rear camera) deliberately omitted —
              // some iOS Safari versions disable multi-select from the
              // photo library when capture is set, which broke the
              // "drag in 6 at once" workflow. Without capture, mobile
              // users still get a picker that includes "Take Photo" as
              // one of the options, AND multi-select from the library
              // works. Desktop picks files normally. Best of both.
              multiple
              className="hidden"
              onChange={handlePickPhotos}
            />
            {stagedPhotos.length > 0 && (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {stagedPhotos.map((p) => (
                  <StagedPhotoThumb
                    key={p.id}
                    file={p.file}
                    onRemove={() => removeStagedPhoto(p.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Plans — optional architectural PDFs. Sits below Photos
              because most visits don't have plans (cold leads from a
              referral usually don't), but when they do exist they're
              valuable input to the quote (m² from the floor plan,
              elevation count from the elevations sheet, etc).
              Multiple files supported because architect packages often
              come as a set: floor plan + elevations + site plan. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Plans <span className="text-muted-foreground/60 normal-case font-normal">(optional)</span>
            </label>
            <div
              onDragEnter={handlePlanDragEnter}
              onDragOver={handlePlanDragOver}
              onDragLeave={handlePlanDragLeave}
              onDrop={handlePlanDrop}
              onClick={() => planInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  planInputRef.current?.click();
                }
              }}
              className={cn(
                'w-full min-h-[72px] rounded-xl border-2 border-dashed cursor-pointer transition-colors flex flex-col items-center justify-center gap-1 px-3 py-3 text-sm font-medium text-foreground',
                planDragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-input bg-background hover:bg-accent',
              )}
            >
              <div className="flex items-center gap-2">
                <FileText size={16} strokeWidth={1.8} />
                {stagedPlans.length === 0
                  ? 'Choose or drop plan PDFs'
                  : `Add more (${stagedPlans.length} so far)`}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Floor plans, elevations, site plans, colour schedules.
              </p>
            </div>
            <input
              ref={planInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={handlePickPlans}
            />
            {stagedPlans.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {stagedPlans.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/40 border border-border"
                  >
                    <FileText size={14} className="text-muted-foreground shrink-0" strokeWidth={1.8} />
                    <p className="text-xs text-foreground truncate flex-1 min-w-0">
                      {p.file.name}
                    </p>
                    <button
                      type="button"
                      onClick={(e) => {
                        // Stop the parent drop-zone div from catching this
                        // click and re-opening the picker.
                        e.stopPropagation();
                        removeStagedPlan(p.id);
                      }}
                      className="w-6 h-6 rounded-full hover:bg-background flex items-center justify-center text-muted-foreground hover:text-foreground"
                      title={`Remove ${p.file.name}`}
                    >
                      <X size={12} strokeWidth={2.2} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Work type — quick chip select. Less typing than a dropdown. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Work type
            </label>
            <div className="flex flex-wrap gap-2">
              {WORK_TYPES.map(({ value, label }) => {
                const selected = workType === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setWorkType(selected ? '' : value)}
                    className={cn(
                      'px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[40px]',
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:border-primary/40',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Prep level — same chip pattern. Hint shown alongside the
              label so Brad doesn't have to guess what "medium" means. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Prep level
            </label>
            <div className="space-y-1.5">
              {PREP_LEVELS.map(({ value, label, hint }) => {
                const selected = prepLevel === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPrepLevel(selected ? '' : value)}
                    className={cn(
                      'w-full px-3 py-2.5 rounded-lg text-left border transition-colors',
                      selected
                        ? 'bg-primary/10 border-primary'
                        : 'bg-background border-border hover:border-primary/40',
                    )}
                  >
                    <p className="text-sm font-medium text-foreground">{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Surface area — a single number for now. The quote table
              has a richer surface_area_m2_by_zone JSON column but
              entering by-zone is too much for a 30-second wrap-up.
              Tier 2 can break it down when refining the quote draft. */}
          {/* Paint area, NOT floor area. Distinct because anyone
              glancing at a floor plan will see m² numbers everywhere
              (footprint, site coverage, etc) and naturally type those
              in. We want walls/cladding/soffit area — the actual
              surface that gets paint on it. The hint explicitly calls
              this out so the field doesn't get filled with a 416 m²
              floor footprint when the cladding is only 280 m². */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Paint area (m²)
            </label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="e.g. 180"
              value={surfaceAreaM2}
              onChange={(e) => setSurfaceAreaM2(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              Walls, cladding or surface being painted — not the floor footprint.
              Rough is fine; refine when you write the quote.
            </p>
          </div>

          {/* Coats — three-chip selector. The single biggest lever on
              labour cost after area: each extra coat is ~1 extra day
              for a 100m² job once drying time is factored in. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Coats
            </label>
            <div className="flex flex-wrap gap-2">
              {(['1', '2', '3'] as const).map((n) => {
                const selected = coatsCount === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCoatsCount(selected ? '' : n)}
                    className={cn(
                      'px-4 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[40px]',
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:border-primary/40',
                    )}
                  >
                    {n} coat{n === '1' ? '' : 's'}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Stain / paint product — free text. Brad knows his
              preferred brands and the form shouldn't force a dropdown
              when his vocab is a moving target. Recent values could
              be turned into autocomplete suggestions later. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Stain or paint product
            </label>
            <input
              type="text"
              placeholder="e.g. Wood-X mid cedar, Cedarshield natural, Resene Woodsman"
              value={stainProduct}
              onChange={(e) => setStainProduct(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
          </div>

          {/* Windows + doors count — drives cutting-in time estimate.
              Quick rough count rather than an exact number; one stray
              skylight not counted is fine, but ten skylights missed
              would change the quote materially. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Windows + doors (count)
            </label>
            <input
              type="number"
              inputMode="numeric"
              placeholder="e.g. 12"
              value={windowDoorCount}
              onChange={(e) => setWindowDoorCount(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              Rough count in the painted area — each window is ~10 mins of careful cut-in.
            </p>
          </div>

          {/* Access notes — multi-select chips. Most of these chips
              are price-relevant (scaffold doubles labour costs vs.
              ladder) so even rough capture here pays off. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Access &amp; site notes
            </label>
            <div className="flex flex-wrap gap-2">
              {ACCESS_CHIPS.map(({ value, label }) => {
                const selected = accessChips.has(value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleAccessChip(value)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:border-primary/40',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Add-ons — multi-select chips. These are the "easy to
              forget to scope, easy to lose money on" items. Forcing
              the question to be asked explicitly here means Brad
              doesn't get a "and you'll do the soffits too, right?"
              conversation two weeks later that costs him a half-day. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Add-ons in scope
            </label>
            <div className="flex flex-wrap gap-2">
              {ADDON_CHIPS.map(({ value, label }) => {
                const selected = addonChips.has(value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleAddonChip(value)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:border-primary/40',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Site logistics — multi-select chips. Practical realities
              for the crew. Each chip changes how the job runs, not
              what's quoted, but they're worth capturing as Tier-2 may
              use them for "things to mention in the quote" copy. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Site logistics
            </label>
            <div className="flex flex-wrap gap-2">
              {SITE_LOGISTICS_CHIPS.map(({ value, label }) => {
                const selected = siteLogisticsChips.has(value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleSiteLogisticsChip(value)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:border-primary/40',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time estimate — Brad's gut feel after walking the site.
              The AI compares this against the area × prep math; when
              they disagree by more than ~30%, it's a useful prompt
              for a second look. Decimal allowed for half-days. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Days estimate (gut feel)
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="0.5"
              placeholder="e.g. 4"
              value={daysEstimate}
              onChange={(e) => setDaysEstimate(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              How many working days do you think? Half-days are fine (e.g. 3.5).
            </p>
          </div>

          {/* Commercial signals — multi-select chips. These move the
              quote price ±15% without changing the cost. A referred
              quality-focused customer doesn't get the same number as
              a price-shopping urgent one even when the work is
              identical. Captured separately from scope so the AI can
              treat them as a different kind of input. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Customer / commercial signals
            </label>
            <div className="flex flex-wrap gap-2">
              {COMMERCIAL_CHIPS.map(({ value, label }) => {
                const selected = commercialChips.has(value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleCommercialChip(value)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:border-primary/40',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Free-form scope text — the brain dump. Big textarea so
              Brad can ramble. Future feature: a mic button here to
              dictate while walking back to the van. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
              Scope of work
            </label>
            <Textarea
              placeholder="What did you agree to do? Anything tricky? Materials/colours discussed?"
              value={scopeNotes}
              onChange={(e) => setScopeNotes(e.target.value)}
              className="resize-none text-sm"
              rows={5}
            />
          </div>

          {/* Quote-ready-by date. The promise. Bumps a counter on
              Home later ('1 quote owed'). */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block flex items-center gap-1.5">
              <CalendarClock size={11} strokeWidth={1.8} />
              I'll send the quote by
            </label>
            <input
              type="date"
              value={quoteReadyBy}
              onChange={(e) => setQuoteReadyBy(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={onCancel}
              disabled={saving}
            >
              Skip
            </Button>
            <Button
              className="flex-1 bg-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving
                ? 'Saving…'
                : (() => {
                    // Build a fileset summary so Brad knows what's about
                    // to upload — e.g. "Save + upload 4 photos + 2 plans".
                    // Falls back to plain "Save" when nothing's staged.
                    const parts: string[] = [];
                    if (stagedPhotos.length > 0) {
                      parts.push(`${stagedPhotos.length} photo${stagedPhotos.length === 1 ? '' : 's'}`);
                    }
                    if (stagedPlans.length > 0) {
                      parts.push(`${stagedPlans.length} plan${stagedPlans.length === 1 ? '' : 's'}`);
                    }
                    return parts.length > 0
                      ? `Save + upload ${parts.join(' + ')}`
                      : 'Save';
                  })()}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Staged photo thumb ────────────────────────────────────────────────────

function StagedPhotoThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  // Generate a transient blob URL for the preview thumbnail. Revoke on
  // unmount so we don't leak memory if Brad picks dozens of photos
  // before saving.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  return (
    <div className="relative aspect-square rounded-lg overflow-hidden border border-border bg-muted">
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="w-full h-full object-cover" />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
        title="Remove this photo"
      >
        <X size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}
