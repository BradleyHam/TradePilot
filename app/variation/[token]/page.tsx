import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { VariationResponse } from './variation-response';
import { Camera, Paintbrush, ReceiptText } from 'lucide-react';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function money(amount: number): string {
  return amount.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
}

export default async function VariationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!UUID.test(token)) notFound();

  const { data: variation, error: variationError } = await supabaseAdmin
    .from('job_variations')
    .select('id, business_id, job_id, title, description, amount_ex_gst, status, photo_ids')
    .eq('approval_token', token)
    .maybeSingle();
  if (variationError) console.error('[variation page] load failed:', variationError);
  if (!variation || !['ready', 'approved', 'declined'].includes(variation.status)) notFound();

  const [{ data: job }, { data: business }] = await Promise.all([
    supabaseAdmin.from('jobs').select('name, client_name').eq('id', variation.job_id).maybeSingle(),
    supabaseAdmin.from('businesses').select('name').eq('id', variation.business_id).maybeSingle(),
  ]);
  if (!job || !business) notFound();

  const photoIds = Array.isArray(variation.photo_ids) ? variation.photo_ids as string[] : [];
  let photos: { id: string; url: string }[] = [];
  if (photoIds.length > 0) {
    const { data: rows } = await supabaseAdmin
      .from('shift_photos')
      .select('id, storage_path')
      .eq('job_id', variation.job_id)
      .in('id', photoIds);
    if (rows && rows.length > 0) {
      const { data: signed } = await supabaseAdmin.storage
        .from('shift-photos')
        .createSignedUrls(rows.map((row) => row.storage_path), 3600);
      const urlsByPath = new Map((signed ?? []).map((item) => [item.path, item.signedUrl]));
      photos = rows.flatMap((row) => {
        const url = urlsByPath.get(row.storage_path);
        return url ? [{ id: row.id, url }] : [];
      });
    }
  }

  const amountExGst = Number(variation.amount_ex_gst);
  const gst = Math.round(amountExGst * 0.15 * 100) / 100;
  const amountInclGst = Math.round((amountExGst + gst) * 100) / 100;
  const clientFirstName = job.client_name?.trim().split(/\s+/)[0];

  return (
    <main className="min-h-dvh bg-[#f6f3ef] px-4 py-6 text-slate-950 sm:py-10">
      <div className="mx-auto max-w-xl">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f25a00] text-white shadow-sm">
            <Paintbrush size={21} />
          </span>
          <div>
            <p className="text-sm font-bold">{business.name}</p>
            <p className="text-xs text-slate-500">Additional work approval</p>
          </div>
        </div>

        <section className="overflow-hidden rounded-[28px] border border-black/5 bg-white shadow-[0_18px_60px_rgba(35,25,15,0.08)]">
          <div className="px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
            {clientFirstName && <p className="text-sm text-slate-500">Hi {clientFirstName},</p>}
            <h1 className="mt-1 text-2xl font-bold tracking-tight">{variation.title}</h1>
            <p className="mt-1 text-sm font-medium text-[#c84b00]">{job.name}</p>
            {variation.description && (
              <p className="mt-4 whitespace-pre-wrap text-[15px] leading-7 text-slate-600">{variation.description}</p>
            )}
          </div>

          {photos.length > 0 && (
            <div className="border-y border-slate-100 bg-slate-50 px-5 py-5 sm:px-7">
              <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                <Camera size={15} /> Photos from the job
              </p>
              <div className={photos.length === 1 ? 'grid grid-cols-1' : 'grid grid-cols-2 gap-2'}>
                {photos.map((photo) => (
                  <a key={photo.id} href={photo.url} target="_blank" rel="noopener noreferrer" className="block aspect-[4/3] overflow-hidden rounded-2xl bg-slate-200">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.url} alt="Extra work at the job" className="h-full w-full object-cover" />
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="px-5 py-5 sm:px-7">
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                <ReceiptText size={15} /> Additional price
              </p>
              <div className="mt-3 flex items-end justify-between gap-4">
                <div>
                  <p className="text-3xl font-black tracking-tight">{money(amountInclGst)}</p>
                  <p className="mt-0.5 text-xs text-slate-500">including GST</p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <p>{money(amountExGst)} ex GST</p>
                  <p>{money(gst)} GST</p>
                </div>
              </div>
            </div>

            <div className="mt-5">
              <VariationResponse
                token={token}
                initialStatus={variation.status as 'ready' | 'approved' | 'declined'}
                amountInclGst={amountInclGst}
              />
            </div>
          </div>
        </section>

        <p className="mx-auto mt-5 max-w-sm text-center text-xs leading-relaxed text-slate-500">
          This private link was created by {business.name} for this job. Contact them directly if anything does not look right.
        </p>
      </div>
    </main>
  );
}
