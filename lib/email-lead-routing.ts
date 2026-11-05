import type { EmailLeadFields } from './email-lead-parser';

export interface EmailJobCandidate {
  id: string; name: string; client_email: string | null; location: string | null;
  status: string; notes: string | null;
}
const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Never merge new work merely because a sender already has a job. */
export function matchEmailJob(jobs: EmailJobCandidate[], lead: EmailLeadFields,
  input: { followUp: boolean; originalLink?: string; threadJobIds: string[] }): string | undefined {
  const exact = jobs.filter(j => input.originalLink && j.notes?.includes(input.originalLink));
  if (exact.length === 1) return exact[0].id;
  if (input.followUp) {
    const thread = jobs.filter(j => input.threadJobIds.includes(j.id));
    if (thread.length === 1) return thread[0].id;
    // Multiple opportunities in the same conversation need human review.
    if (thread.length > 1) return undefined;
    const byEmail = jobs.filter(j => lead.clientEmail && j.client_email?.toLowerCase() === lead.clientEmail.toLowerCase());
    const address = byEmail.filter(j => norm(lead.location).length > 5 && norm(j.location) === norm(lead.location));
    if (address.length === 1) return address[0].id;
    if (address.length > 1) return undefined;
    return byEmail.length === 1 ? byEmail[0].id : undefined;
  }
  // A form and email relay may both deliver the identical first enquiry.
  const same = jobs.filter(j => lead.clientEmail && j.client_email?.toLowerCase() === lead.clientEmail.toLowerCase()
    && norm(j.name) === norm(lead.name) && norm(lead.location).length > 5
    && norm(j.location) === norm(lead.location) && !['paid','completed','lost','declined'].includes(j.status));
  return same.length === 1 ? same[0].id : undefined;
}

export function scannerIsStale(value: string | null | undefined, now = Date.now()): boolean {
  if (!value) return false; // not enabled yet
  try { const health = JSON.parse(value); return !Number.isFinite(Date.parse(health.checkedAt)) || now - Date.parse(health.checkedAt) > 2 * 3600000; }
  catch { return true; }
}
