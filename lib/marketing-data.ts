// Marketing data loaders — SERVER-ONLY (uses the service-role admin client).
//
// Pulls everything the website-publish pipeline needs for one job: the job
// row, its before/after photo attachments (reusing the quote_attachments
// pipeline), and the marketing description/status blob from settings.
//
// Imported only by the /api/marketing routes. Never import from the browser.

import { supabaseAdmin } from './supabase/admin';
import { rowToJob, rowToQuoteAttachment } from './supabase/mappers';
import type { Job, QuoteAttachment, JobMarketing } from './types';

// "Before" folds in scope photos (site-visit shots), matching the Marketing tab.
const BEFORE_KINDS = new Set(['before_photo', 'scope_photo']);

export interface JobMarketingContext {
  job: Job;
  /** before_photo + scope_photo attachments. */
  before: QuoteAttachment[];
  /** after_photo attachments. */
  after: QuoteAttachment[];
  /** process_photo (work-in-progress) attachments. */
  process: QuoteAttachment[];
  marketing: JobMarketing | null;
}

export async function loadJobMarketingContext(jobId: string): Promise<JobMarketingContext> {
  const { data: jobRow, error: jobErr } = await supabaseAdmin
    .from('jobs').select('*').eq('id', jobId).single();
  if (jobErr || !jobRow) throw new Error(`Job not found (${jobErr?.message ?? jobId})`);
  const job = rowToJob(jobRow);

  // Quote ids for this job (attachments hang off quotes, not jobs directly).
  const { data: quoteRows, error: qErr } = await supabaseAdmin
    .from('quotes').select('id').eq('job_id', jobId);
  if (qErr) throw new Error(`Failed to load quotes: ${qErr.message}`);
  const quoteIds = (quoteRows ?? []).map((r) => r.id as string);

  let attachments: QuoteAttachment[] = [];
  if (quoteIds.length > 0) {
    const { data: attRows, error: aErr } = await supabaseAdmin
      .from('quote_attachments').select('*').in('quote_id', quoteIds);
    if (aErr) throw new Error(`Failed to load attachments: ${aErr.message}`);
    attachments = (attRows ?? []).map(rowToQuoteAttachment);
  }

  const before = attachments.filter((a) => BEFORE_KINDS.has(a.kind));
  const after = attachments.filter((a) => a.kind === 'after_photo');
  const process = attachments.filter((a) => a.kind === 'process_photo');

  // Marketing description/status blob (settings key `marketing:{jobId}`).
  const { data: setRow } = await supabaseAdmin
    .from('settings').select('value')
    .eq('business_id', job.businessId)
    .eq('key', `marketing:${jobId}`)
    .maybeSingle();

  let marketing: JobMarketing | null = null;
  if (setRow && typeof setRow.value === 'string' && setRow.value) {
    try {
      const parsed = JSON.parse(setRow.value) as Partial<JobMarketing>;
      marketing = {
        jobId,
        title: parsed.title,
        description: parsed.description,
        overview: Array.isArray(parsed.overview) ? parsed.overview : undefined,
        services: Array.isArray(parsed.services) ? parsed.services : undefined,
        status: parsed.status ?? 'draft',
        heroAttachmentId: parsed.heroAttachmentId,
        heroMode: parsed.heroMode,
        heroBeforeId: parsed.heroBeforeId,
        heroAfterId: parsed.heroAfterId,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      // Corrupt blob — treat as no marketing data rather than failing the pull.
    }
  }

  return { job, before, after, process, marketing };
}

/** Flip the job's marketing status to 'published', preserving the description. */
export async function markJobMarketingPublished(
  job: Pick<Job, 'id' | 'businessId'>,
  prev: JobMarketing | null,
): Promise<void> {
  const value = JSON.stringify({
    jobId: job.id,
    title: prev?.title,
    description: prev?.description,
    overview: prev?.overview,
    services: prev?.services,
    status: 'published',
    heroAttachmentId: prev?.heroAttachmentId,
    heroMode: prev?.heroMode,
    heroBeforeId: prev?.heroBeforeId,
    heroAfterId: prev?.heroAfterId,
    updatedAt: new Date().toISOString(),
  });
  const { error } = await supabaseAdmin.from('settings').upsert(
    { business_id: job.businessId, key: `marketing:${job.id}`, value },
    { onConflict: 'business_id,key' },
  );
  if (error) {
    // Non-fatal: the page files are already written; status is cosmetic.
    console.warn('[website-publish] could not mark published:', error.message);
  }
}
