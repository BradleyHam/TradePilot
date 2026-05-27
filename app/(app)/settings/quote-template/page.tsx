'use client';

// Quote template settings — the per-business defaults the future AI
// quote drafter + PDF renderer will use as the visual + textual frame
// for every generated quote. Settings UI for the JSON blob stored at
// settings(key='quote_template') (seeded by migration 014).
//
// Scope deliberately tight for v1: header fields + payment terms +
// validity + T&Cs + a logo upload. No progress payments, no rich
// text editor for T&Cs (plain text with hyphen-bullets is fine for
// a quote document). When Brad needs more flexibility we'll extend.
//
// All fields are optional from a save-validity POV — the PDF
// generator handles missing fields with sensible placeholders rather
// than refusing to render. The settings page just shows what's set
// and lets you fill in the blanks.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useStore } from '@/lib/store';
import type { QuoteTemplate } from '@/lib/types';
import {
  ChevronLeft, Upload, X, Check, AlertCircle, ImageIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Default values shown in the form when no template row exists OR when
// a field is missing from the saved template. Keeps the seed sensible
// for any business that hasn't filled the form out yet.
const DEFAULT_TEMPLATE: QuoteTemplate = {
  header: {
    businessName: '',
    gstNumber: '',
    phone: '',
    email: '',
    address: '',
    logoStoragePath: undefined,
  },
  paymentTerms: {
    depositPercent: 30,
    depositDueDays: 7,
    balanceDue: 'on_completion',
  },
  validityDays: 30,
  gstTreatment: 'incl',
  defaultTerms: '',
};

export default function QuoteTemplateSettingsPage() {
  const {
    getQuoteTemplate, saveQuoteTemplate, uploadBusinessLogo, resolveLogoUrl,
  } = useStore();

  // Form state — hydrated from the store on mount. Editing locally,
  // saved on Save. Bailing on partial edits and starting over is fine
  // because every field is just a default the customer-facing quote
  // can render around. No optimistic / mid-save ambiguity to worry about.
  const [template, setTemplate] = useState<QuoteTemplate>(DEFAULT_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [savedJustNow, setSavedJustNow] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // True while an image is being dragged over the logo zone. Mirrors
  // the photo-zone pattern in the wrap-up sheet — gives the user
  // visual confirmation that the drop target is accepting the file.
  const [logoDragActive, setLogoDragActive] = useState(false);

  // Hydrate once from the store. We use a stable ref-check so reloading
  // the page doesn't blow away in-progress edits. (getQuoteTemplate
  // is stable across re-renders because settings is its dep.)
  useEffect(() => {
    const loaded = getQuoteTemplate();
    if (loaded) {
      // Merge with DEFAULT_TEMPLATE so missing fields fall back to
      // sensible values rather than undefined inputs throwing
      // controlled-component warnings.
      setTemplate({
        ...DEFAULT_TEMPLATE,
        ...loaded,
        header: { ...DEFAULT_TEMPLATE.header, ...loaded.header },
        paymentTerms: { ...DEFAULT_TEMPLATE.paymentTerms, ...loaded.paymentTerms },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolved logo URL for the preview. Memoised so the lookup doesn't
  // happen on every keystroke.
  const logoUrl = useMemo(
    () => resolveLogoUrl(template.header.logoStoragePath),
    [resolveLogoUrl, template.header.logoStoragePath],
  );

  function setHeader<K extends keyof QuoteTemplate['header']>(
    key: K, value: QuoteTemplate['header'][K],
  ) {
    setTemplate((t) => ({ ...t, header: { ...t.header, [key]: value } }));
  }

  function setPaymentTerm<K extends keyof QuoteTemplate['paymentTerms']>(
    key: K, value: QuoteTemplate['paymentTerms'][K],
  ) {
    setTemplate((t) => ({ ...t, paymentTerms: { ...t.paymentTerms, [key]: value } }));
  }

  /**
   * Core upload flow shared by the file-picker AND drag-and-drop.
   * Both routes funnel a single File here so error handling, immediate
   * save, and the uploading flag stay consistent.
   *
   * Filters to images only — a PDF dropped on the logo zone gets
   * silently ignored rather than uploaded as if it were a logo.
   */
  async function handleLogoFile(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('Logo must be an image (PNG, JPG, or SVG).');
      return;
    }
    setUploadingLogo(true);
    setError(null);
    try {
      const path = await uploadBusinessLogo(file);
      if (path) {
        // Update local template + persist immediately so the URL is
        // saved alongside the upload. Without the immediate save, a
        // refresh-before-Save would orphan the upload.
        const next = { ...template, header: { ...template.header, logoStoragePath: path } };
        setTemplate(next);
        const res = await saveQuoteTemplate(next);
        if (!res.ok) setError(res.error ?? 'Failed to save logo path');
      } else {
        setError('Logo upload failed — check the file size and format.');
      }
    } finally {
      setUploadingLogo(false);
    }
  }

  async function handleLogoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;
    await handleLogoFile(file);
  }

  // ── Logo drag-and-drop ────────────────────────────────────────────
  // Standard HTML5 DnD plumbing. preventDefault on dragOver is
  // mandatory or the browser will intercept the drop and try to open
  // the image in a new tab.
  function handleLogoDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setLogoDragActive(true);
  }
  function handleLogoDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!logoDragActive) setLogoDragActive(true);
  }
  function handleLogoDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    // Keep the highlight while moving across child elements — only
    // clear when we've genuinely left the drop zone.
    const rel = e.relatedTarget as Node | null;
    if (rel && (e.currentTarget as Node).contains(rel)) return;
    setLogoDragActive(false);
  }
  async function handleLogoDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setLogoDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await handleLogoFile(file);
  }

  async function handleRemoveLogo() {
    // Just clear the path from the template — we leave the object in
    // storage so a fresh upload to the same path overwrites it, and
    // accidental removals aren't catastrophic (the file's still there
    // if Brad changes his mind tomorrow).
    const next = { ...template, header: { ...template.header, logoStoragePath: undefined } };
    setTemplate(next);
    const res = await saveQuoteTemplate(next);
    if (!res.ok) setError(res.error ?? 'Failed to save');
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedJustNow(false);
    try {
      const res = await saveQuoteTemplate(template);
      if (res.ok) {
        setSavedJustNow(true);
        // Hide the "Saved ✓" hint after a few seconds so the button
        // doesn't look perpetually-just-saved on a static page.
        setTimeout(() => setSavedJustNow(false), 2500);
      } else {
        setError(res.error ?? 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Quote template"
        subtitle="Branding, payment terms and T&Cs used on every quote"
      />

      <div className="px-4 md:px-6 pb-12 space-y-6 w-full max-w-2xl mx-auto">
        {/* Breadcrumb back to settings — settings nav is shallow so a
            plain link is enough. */}
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground -mt-2"
        >
          <ChevronLeft size={12} /> Settings
        </Link>

        {/* Error banner */}
        {error && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertCircle size={14} className="mt-0.5 shrink-0" strokeWidth={2} />
            <span className="flex-1 min-w-0">{error}</span>
          </div>
        )}

        {/* Logo. The whole inner box is a drop zone — drag a logo
            from Finder / Files straight onto the tile area. Tapping
            anywhere also opens the file picker (same affordance as
            the wrap-up sheet's photo zone, kept consistent on purpose). */}
        <Section title="Logo" hint="Appears at the top of every quote PDF. PNG, JPG, or SVG. Drag the file in or tap to choose.">
          <div
            onDragEnter={handleLogoDragEnter}
            onDragOver={handleLogoDragOver}
            onDragLeave={handleLogoDragLeave}
            onDrop={handleLogoDrop}
            onClick={() => !uploadingLogo && fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (uploadingLogo) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={cn(
              'flex items-center gap-3 rounded-xl border-2 border-dashed p-3 cursor-pointer transition-colors',
              logoDragActive
                ? 'border-primary bg-primary/5'
                : 'border-input bg-background hover:bg-accent',
              uploadingLogo && 'cursor-wait opacity-70',
            )}
          >
            {/* Preview tile — 80×80 box with the logo image or a
                placeholder icon when nothing's uploaded. */}
            <div className="w-20 h-20 rounded-xl border border-border bg-muted flex items-center justify-center overflow-hidden shrink-0">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt="Business logo"
                  className="w-full h-full object-contain"
                />
              ) : (
                <ImageIcon size={22} className="text-muted-foreground/50" strokeWidth={1.5} />
              )}
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground inline-flex items-center gap-1.5">
                <Upload size={13} strokeWidth={1.8} />
                {uploadingLogo
                  ? 'Uploading…'
                  : logoUrl
                    ? 'Drop a new logo here or tap to replace'
                    : 'Drop your logo here or tap to choose'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                PNG, JPG, or SVG. Big images get auto-resized to keep PDFs tidy.
              </p>
              {logoUrl && (
                <button
                  type="button"
                  onClick={(e) => {
                    // Don't let the click bubble up to the drop zone's
                    // onClick (which would re-open the file picker).
                    e.stopPropagation();
                    handleRemoveLogo();
                  }}
                  disabled={uploadingLogo}
                  className="self-start mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-red-600"
                >
                  <X size={11} strokeWidth={2} />
                  Remove logo
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
              className="hidden"
              onChange={handleLogoPick}
            />
          </div>
        </Section>

        {/* Business details */}
        <Section title="Business details">
          <div className="space-y-3">
            <Field
              label="Business name"
              value={template.header.businessName ?? ''}
              onChange={(v) => setHeader('businessName', v)}
              placeholder="e.g. Lakeside Painting Ltd"
            />
            <Field
              label="GST number"
              value={template.header.gstNumber ?? ''}
              onChange={(v) => setHeader('gstNumber', v)}
              placeholder="e.g. 123-456-789"
            />
            <Field
              label="Phone"
              value={template.header.phone ?? ''}
              onChange={(v) => setHeader('phone', v)}
              placeholder="e.g. 027 123 4567"
              type="tel"
            />
            <Field
              label="Email"
              value={template.header.email ?? ''}
              onChange={(v) => setHeader('email', v)}
              placeholder="e.g. brad@lakesidepainting.co.nz"
              type="email"
            />
            <Field
              label="Address"
              value={template.header.address ?? ''}
              onChange={(v) => setHeader('address', v)}
              placeholder="e.g. 12 Aubrey Road, Wanaka 9305"
            />
          </div>
        </Section>

        {/* Payment terms */}
        <Section title="Payment terms" hint="Used as the default on every quote.">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Deposit %"
                value={template.paymentTerms.depositPercent}
                onChange={(v) => setPaymentTerm('depositPercent', v)}
                min={0} max={100} step={5}
                suffix="%"
              />
              <NumberField
                label="Deposit due (days)"
                value={template.paymentTerms.depositDueDays}
                onChange={(v) => setPaymentTerm('depositDueDays', v)}
                min={0} max={60} step={1}
                suffix="days"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                Balance payable
              </label>
              <div className="flex gap-2">
                {(['on_completion', 'progress'] as const).map((value) => {
                  const selected = template.paymentTerms.balanceDue === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPaymentTerm('balanceDue', value)}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[40px]',
                        selected
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-foreground border-border hover:border-primary/40',
                      )}
                    >
                      {value === 'on_completion' ? 'On completion' : 'Progress payments'}
                    </button>
                  );
                })}
              </div>
              {/* Plain-text hint so the chip choice isn't ambiguous. */}
              <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                On completion = single balance payment when the job's done.
                Progress = midway + final (not yet implemented in PDFs — coming later).
              </p>
            </div>
          </div>
        </Section>

        {/* Validity + GST */}
        <Section title="Quote behaviour">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Validity (days)"
              value={template.validityDays}
              onChange={(v) => setTemplate((t) => ({ ...t, validityDays: v }))}
              min={1} max={365} step={1}
              suffix="days"
            />
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                GST display
              </label>
              <div className="flex gap-2">
                {(['incl', 'excl'] as const).map((value) => {
                  const selected = template.gstTreatment === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTemplate((t) => ({ ...t, gstTreatment: value }))}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors min-h-[40px]',
                        selected
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-foreground border-border hover:border-primary/40',
                      )}
                    >
                      {value === 'incl' ? 'Inc GST' : 'Ex GST'}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Section>

        {/* T&Cs */}
        <Section
          title="Terms & conditions"
          hint="Appears at the bottom of every quote. Use new lines for bullets — each line becomes a separate item on the PDF."
        >
          <Textarea
            placeholder={'• Quote valid for 30 days from issue date.\n• 30% deposit required to confirm booking.\n• Balance payable on completion.\n• Two coats applied to all surfaces unless specified otherwise.'}
            value={template.defaultTerms ?? ''}
            onChange={(e) => setTemplate((t) => ({ ...t, defaultTerms: e.target.value }))}
            className="resize-none text-sm font-mono"
            rows={8}
          />
        </Section>

        {/* Save row */}
        <div className="flex items-center gap-3 sticky bottom-0 bg-background/80 backdrop-blur py-3 -mx-4 px-4 md:-mx-6 md:px-6 border-t border-border">
          <Button
            className="flex-1 bg-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save template'}
          </Button>
          {savedJustNow && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <Check size={12} /> Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Layout helpers ──────────────────────────────────────────────────────

function Section({
  title, hint, children,
}: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="bg-card rounded-2xl border border-border p-4 md:p-5">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {hint && <p className="text-xs text-muted-foreground mt-1 mb-3">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

function Field({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
      />
    </div>
  );
}

function NumberField({
  label, value, onChange, min, max, step, suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
        {label}
      </label>
      <div className="relative">
        <input
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            // NaN → fall back to 0; keeps the controlled input sane
            // when the user clears the field mid-edit.
            onChange(Number.isFinite(n) ? n : 0);
          }}
          className="w-full h-10 px-3 pr-12 rounded-lg border border-input bg-background text-sm"
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
