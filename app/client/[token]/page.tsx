import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  CalendarDays, Camera, Check, CheckCircle2, Clock3, ExternalLink,
  FileText, MapPin, Paintbrush, ReceiptText, ShieldCheck,
} from 'lucide-react';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ClientQuoteResponse } from './client-quote-response';
import { VariationResponse } from '@/app/variation/[token]/variation-response';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Private job page',
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GST_RATE = 0.15;

type PortalLinkRow = {
  id: string;
  business_id: string;
  job_id: string;
  enabled: boolean;
  quote_accepted_at: string | null;
  quote_accepted_by: string | null;
};

type PortalJobRow = {
  id: string;
  name: string;
  client_name: string;
  location: string | null;
  status: string;
  quote_amount: number | string | null;
  scope_included: unknown;
  scope_excluded: unknown;
};

type PortalScheduleRow = {
  id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
};

type PortalInvoiceRow = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  status: string;
  due_date: string | null;
  kind: string;
  amount_ex_gst: number | string;
  gst_applies: boolean;
  amount_incl_gst: number | string | null;
  paid: boolean;
  paid_date: string | null;
};

type PortalVariationRow = {
  id: string;
  title: string;
  description: string | null;
  amount_ex_gst: number | string;
  status: 'ready' | 'approved' | 'declined';
  approval_token: string;
  responded_at: string | null;
};

type PortalPhotoRow = {
  id: string;
  storage_path: string;
  caption: string | null;
  taken_on: string;
};

type PortalQuoteRow = {
  id: string;
  date_sent: string | null;
  scope_summary: string | null;
  created_at: string;
};

function money(amount: number): string {
  return amount.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
}

function numeric(value: number | string | null | undefined): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function dateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-NZ', {
    weekday: 'short', day: 'numeric', month: 'long',
  });
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-NZ', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function timeLabel(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const tidy = (value: string) => {
    const [hours, minutes] = value.split(':').map(Number);
    const suffix = hours >= 12 ? 'pm' : 'am';
    const hour = hours % 12 || 12;
    return `${hour}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}${suffix}`;
  };
  return end ? `${tidy(start)}–${tidy(end)}` : tidy(start);
}

const STAGES = ['Quote', 'Approved', 'Scheduled', 'Underway', 'Complete'] as const;

function stageIndex(status: string): number {
  if (status === 'quoted') return 0;
  if (status === 'accepted') return 1;
  if (status === 'booked') return 2;
  if (status === 'in-progress') return 3;
  if (['completed', 'invoiced', 'paid'].includes(status)) return 4;
  return 0;
}

function clientStatus(status: string): string {
  if (status === 'quoted') return 'Quote ready';
  if (status === 'accepted') return 'Quote approved';
  if (status === 'booked') return 'Work scheduled';
  if (status === 'in-progress') return 'Work underway';
  if (status === 'completed') return 'Work complete';
  if (status === 'invoiced') return 'Final invoice issued';
  if (status === 'paid') return 'Paid · job complete';
  return 'Job update';
}

export default async function ClientJobPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!UUID.test(token)) notFound();

  const { data: rawLink, error: linkError } = await supabaseAdmin
    .from('job_client_links')
    .select('id, business_id, job_id, enabled, quote_accepted_at, quote_accepted_by')
    .eq('access_token', token)
    .eq('enabled', true)
    .maybeSingle();
  if (linkError) console.error('[client job page] link load failed:', linkError);
  if (!rawLink) notFound();
  const link = rawLink as PortalLinkRow;

  const today = localToday();
  const [jobResult, businessResult, scheduleResult, invoiceResult, variationResult, photoResult, quoteResult] = await Promise.all([
    supabaseAdmin
      .from('jobs')
      .select('id, name, client_name, location, status, quote_amount, scope_included, scope_excluded')
      .eq('id', link.job_id)
      .eq('business_id', link.business_id)
      .maybeSingle(),
    supabaseAdmin.from('businesses').select('name').eq('id', link.business_id).maybeSingle(),
    supabaseAdmin
      .from('schedule_items')
      .select('id, date, start_time, end_time')
      .eq('business_id', link.business_id)
      .eq('job_id', link.job_id)
      .eq('type', 'job_booking')
      .eq('completed', false)
      .is('skip_reason_kind', null)
      .gte('date', today)
      .order('date', { ascending: true })
      .limit(8),
    supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, invoice_date, status, due_date, kind, amount_ex_gst, gst_applies, amount_incl_gst, paid, paid_date')
      .eq('business_id', link.business_id)
      .eq('job_id', link.job_id)
      .in('status', ['sent', 'paid'])
      .order('invoice_date', { ascending: false }),
    supabaseAdmin
      .from('job_variations')
      .select('id, title, description, amount_ex_gst, status, approval_token, responded_at')
      .eq('business_id', link.business_id)
      .eq('job_id', link.job_id)
      .in('status', ['ready', 'approved', 'declined'])
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('shift_photos')
      .select('id, storage_path, caption, taken_on')
      .eq('business_id', link.business_id)
      .eq('job_id', link.job_id)
      .eq('client_visible', true)
      .order('taken_on', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(24),
    supabaseAdmin
      .from('quotes')
      .select('id, date_sent, scope_summary, created_at')
      .eq('business_id', link.business_id)
      .eq('job_id', link.job_id)
      .order('date_sent', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }),
  ]);

  if (jobResult.error) console.error('[client job page] job load failed:', jobResult.error);
  if (!jobResult.data || !businessResult.data) notFound();

  const job = jobResult.data as PortalJobRow;
  const businessName = businessResult.data.name as string;
  // A previously shared URL must stop exposing job details if the work is
  // later lost or turned down, even before Brad explicitly disables it.
  if (job.status === 'lost' || job.status === 'declined') notFound();

  // Best-effort activity signal. A stats write can never stop the client
  // opening the useful page they were given.
  const { error: viewError } = await supabaseAdmin.rpc('record_client_job_link_view', { p_token: token });
  if (viewError) console.warn('[client job page] view signal failed:', viewError.message);

  const schedules = (scheduleResult.data ?? []) as PortalScheduleRow[];
  const invoices = (invoiceResult.data ?? []) as PortalInvoiceRow[];
  const variations = (variationResult.data ?? []) as PortalVariationRow[];
  const photos = (photoResult.data ?? []) as PortalPhotoRow[];
  const quotes = (quoteResult.data ?? []) as PortalQuoteRow[];
  const latestQuote = quotes[0];

  let quotePdfUrl: string | null = null;
  if (quotes.length > 0) {
    const { data: quotePdfs } = await supabaseAdmin
      .from('quote_attachments')
      .select('storage_path, created_at')
      .eq('business_id', link.business_id)
      .in('quote_id', quotes.map((quote) => quote.id))
      .eq('kind', 'quote_pdf')
      .order('created_at', { ascending: false })
      .limit(1);
    const path = quotePdfs?.[0]?.storage_path as string | undefined;
    if (path) {
      const { data: signed } = await supabaseAdmin.storage.from('quote-attachments').createSignedUrl(path, 1800);
      quotePdfUrl = signed?.signedUrl ?? null;
    }
  }

  let photoUrls = new Map<string, string>();
  if (photos.length > 0) {
    const { data: signedPhotos } = await supabaseAdmin.storage
      .from('shift-photos')
      .createSignedUrls(photos.map((photo) => photo.storage_path), 3600);
    photoUrls = new Map((signedPhotos ?? []).flatMap((item) => (
      item.path && item.signedUrl ? [[item.path, item.signedUrl] as const] : []
    )));
  }

  const scopeIncluded = Array.isArray(job.scope_included) ? job.scope_included.filter((item): item is string => typeof item === 'string') : [];
  const scopeExcluded = Array.isArray(job.scope_excluded) ? job.scope_excluded.filter((item): item is string => typeof item === 'string') : [];
  const quoteExGst = numeric(job.quote_amount);
  const quoteInclGst = Math.round(quoteExGst * (1 + GST_RATE) * 100) / 100;
  const acceptedStatuses = ['accepted', 'booked', 'in-progress', 'completed', 'invoiced', 'paid'];
  const quoteAccepted = Boolean(link.quote_accepted_at) || acceptedStatuses.includes(job.status);
  const currentStage = stageIndex(job.status);
  const firstName = job.client_name.trim().split(/\s+/)[0];

  const invoiceIncl = (invoice: PortalInvoiceRow) => {
    if (invoice.amount_incl_gst != null) return numeric(invoice.amount_incl_gst);
    return numeric(invoice.amount_ex_gst) * (invoice.gst_applies ? 1 + GST_RATE : 1);
  };
  const invoicedTotal = invoices.reduce((sum, invoice) => sum + invoiceIncl(invoice), 0);
  const paidTotal = invoices.filter((invoice) => invoice.paid).reduce((sum, invoice) => sum + invoiceIncl(invoice), 0);
  const outstanding = Math.max(0, invoicedTotal - paidTotal);

  return (
    <main className="min-h-dvh bg-[#f6f3ef] px-4 py-6 text-slate-950 sm:py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-5 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f25a00] text-white shadow-sm">
            <Paintbrush size={21} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{businessName}</p>
            <p className="text-xs text-slate-500">Private job page</p>
          </div>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 shadow-sm">
            <ShieldCheck size={13} className="text-green-600" /> Private
          </span>
        </header>

        <section className="overflow-hidden rounded-[28px] border border-black/5 bg-white shadow-[0_18px_60px_rgba(35,25,15,0.08)]">
          <div className="px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
            {firstName && <p className="text-sm text-slate-500">Hi {firstName},</p>}
            <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{job.name}</h1>
                {job.location && <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500"><MapPin size={14} /> {job.location}</p>}
              </div>
              <span className="shrink-0 rounded-full bg-orange-50 px-3 py-1.5 text-xs font-bold text-[#b84400]">{clientStatus(job.status)}</span>
            </div>

            <div className="mt-6 grid grid-cols-5 gap-1">
              {STAGES.map((stage, index) => (
                <div key={stage} className="min-w-0 text-center">
                  <span className={
                    `mx-auto flex h-7 w-7 items-center justify-center rounded-full border-2 text-[11px] font-bold ${index <= currentStage ? 'border-[#f25a00] bg-[#f25a00] text-white' : 'border-slate-200 bg-white text-slate-400'}`
                  }>
                    {index < currentStage ? <Check size={14} /> : index + 1}
                  </span>
                  <p className={`mt-1 truncate text-[9px] font-semibold sm:text-[10px] ${index <= currentStage ? 'text-slate-700' : 'text-slate-400'}`}>{stage}</p>
                </div>
              ))}
            </div>
          </div>

          {photos.length > 0 && (
            <div className="border-y border-slate-100 bg-slate-50 px-5 py-5 sm:px-7">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-500"><Camera size={15} /> Job photos</p>
                <span className="text-xs text-slate-400">{photos.length} shared</span>
              </div>
              <div className={photos.length === 1 ? 'grid grid-cols-1' : 'grid grid-cols-2 gap-2 sm:grid-cols-3'}>
                {photos.map((photo) => {
                  const url = photoUrls.get(photo.storage_path);
                  if (!url) return null;
                  return (
                    <a key={photo.id} href={url} target="_blank" rel="noopener noreferrer" className="group block aspect-[4/3] overflow-hidden rounded-2xl bg-slate-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={photo.caption || 'Progress at the job'} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" />
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-6 px-5 py-6 sm:px-7">
            {(quoteExGst > 0 || latestQuote?.scope_summary || scopeIncluded.length > 0 || scopeExcluded.length > 0) && (
              <section>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.12em] text-slate-500"><FileText size={16} /> Agreed work</h2>
                  {quotePdfUrl && (
                    <a href={quotePdfUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-700">
                      Quote PDF <ExternalLink size={14} />
                    </a>
                  )}
                </div>

                {latestQuote?.scope_summary && <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7 text-slate-600">{latestQuote.scope_summary}</p>}

                {(scopeIncluded.length > 0 || scopeExcluded.length > 0) && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {scopeIncluded.length > 0 && (
                      <div className="rounded-2xl bg-green-50 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-green-800">Included</p>
                        <ul className="mt-2 space-y-2 text-sm text-green-950">
                          {scopeIncluded.map((item) => <li key={item} className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0" /> <span>{item}</span></li>)}
                        </ul>
                      </div>
                    )}
                    {scopeExcluded.length > 0 && (
                      <div className="rounded-2xl bg-slate-50 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Not included</p>
                        <ul className="mt-2 space-y-2 text-sm text-slate-700">
                          {scopeExcluded.map((item) => <li key={item}>• {item}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {quoteExGst > 0 && (
                  <div className="mt-4 rounded-2xl border border-slate-200 p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Current agreed price</p>
                    <div className="mt-2 flex items-end justify-between gap-4">
                      <div>
                        <p className="text-3xl font-black tracking-tight">{money(quoteInclGst)}</p>
                        <p className="mt-0.5 text-xs text-slate-500">including GST</p>
                      </div>
                      <p className="text-right text-xs text-slate-500">{money(quoteExGst)} ex GST</p>
                    </div>
                  </div>
                )}

                {quoteExGst > 0 && (job.status === 'quoted' || quoteAccepted) && (
                  <div className="mt-4">
                    <ClientQuoteResponse
                      token={token}
                      amountInclGst={quoteInclGst}
                      clientName={job.client_name}
                      initiallyAccepted={quoteAccepted}
                      acceptedBy={link.quote_accepted_by ?? undefined}
                    />
                  </div>
                )}
              </section>
            )}

            {schedules.length > 0 && (
              <section className="border-t border-slate-100 pt-6">
                <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.12em] text-slate-500"><CalendarDays size={16} /> Upcoming work</h2>
                <div className="mt-3 space-y-2">
                  {schedules.map((item) => {
                    const time = timeLabel(item.start_time, item.end_time);
                    return (
                      <div key={item.id} className="flex min-h-14 items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-[#d74f00] shadow-sm"><CalendarDays size={18} /></span>
                        <div>
                          <p className="text-sm font-bold">{dateLabel(item.date)}</p>
                          {time && <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500"><Clock3 size={12} /> {time}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {variations.length > 0 && (
              <section className="border-t border-slate-100 pt-6">
                <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.12em] text-slate-500"><ReceiptText size={16} /> Additional work</h2>
                <div className="mt-3 space-y-3">
                  {variations.map((variation) => {
                    const amountIncl = Math.round(numeric(variation.amount_ex_gst) * (1 + GST_RATE) * 100) / 100;
                    return (
                      <div key={variation.id} className="rounded-3xl border border-slate-200 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-bold">{variation.title}</p>
                            {variation.description && <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{variation.description}</p>}
                          </div>
                          <span className="shrink-0 text-sm font-black">+{money(amountIncl)}</span>
                        </div>
                        <div className="mt-4">
                          <VariationResponse
                            token={variation.approval_token}
                            initialStatus={variation.status}
                            amountInclGst={amountIncl}
                            businessName={businessName}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {invoices.length > 0 && (
              <section className="border-t border-slate-100 pt-6">
                <div className="flex items-end justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.12em] text-slate-500"><ReceiptText size={16} /> Invoices</h2>
                  {outstanding > 0 ? <p className="text-sm font-bold text-[#c84b00]">{money(outstanding)} due</p> : <p className="text-sm font-bold text-green-700">All paid</p>}
                </div>
                <div className="mt-3 space-y-2">
                  {invoices.map((invoice) => (
                    <div key={invoice.id} className="flex min-h-16 items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3">
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${invoice.paid ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                        {invoice.paid ? <CheckCircle2 size={18} /> : <ReceiptText size={18} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold">Invoice {invoice.invoice_number}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {invoice.paid
                            ? `Paid${invoice.paid_date ? ` ${shortDate(invoice.paid_date)}` : ''}`
                            : invoice.due_date ? `Due ${shortDate(invoice.due_date)}` : `Issued ${shortDate(invoice.invoice_date)}`}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-black">{money(invoiceIncl(invoice))}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </section>

        <p className="mx-auto mt-5 max-w-md text-center text-xs leading-relaxed text-slate-500">
          This private page is maintained by {businessName}. It contains only information selected for this job and is not searchable on the web.
        </p>
      </div>
    </main>
  );
}
