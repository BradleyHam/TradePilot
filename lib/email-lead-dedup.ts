import { createHash } from 'crypto';

/** Stable marker for retries of the same original email, without exposing its ID. */
export function emailLeadMessageMarker(messageId?: string): string | undefined {
  const id = messageId?.trim();
  if (!id || id.length > 1000) return undefined;
  return `[email-message-sha256:${createHash('sha256').update(id).digest('hex')}]`;
}

/**
 * A contact can have multiple jobs, even at the same address. Only a source
 * message identity is reliable enough to suppress an enquiry automatically.
 * Without one we prefer a possible duplicate to silently losing a lead.
 */
export function isSameEmailLead(notes: unknown, marker?: string): boolean {
  return !!marker && typeof notes === 'string' && notes.includes(marker);
}

/** Deterministic UUID lets the database reject simultaneous retries atomically. */
export function emailLeadJobId(businessId: string, marker?: string): string | undefined {
  if (!marker) return undefined;
  const hex = createHash('sha256').update(`tradepilot-email-lead\0${businessId}\0${marker}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
