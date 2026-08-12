// =============================================================
// High-level "notify the business" helper — dedupe + fan-out
// =============================================================
//
// The one function every sender goes through (cron rules, lead
// webhooks). SERVER-SIDE ONLY — takes the admin client.
//
// Order of operations matters:
//
//   1. Load the business's push subscriptions. ZERO subs → bail
//      WITHOUT claiming the dedupe key, so a notification that would
//      have fired before Brad enabled push still fires on the first
//      run after he does.
//   2. Claim (business_id, rule_key, dedupe_key) in notification_log
//      via `insert … on conflict do nothing`. No row back → another
//      run already sent this one. This is what makes an overlapping /
//      re-run cron safe, and what stops repeat-nagging: a rule fires
//      ONCE per dedupe key, ever. Escalations use new keys.
//   3. Send to every subscription. 404/410 → that device is dead
//      (app deleted, permission revoked, iOS evicted it) → delete the
//      row so we stop paying for it.
//
// Tradeoff, on purpose: the key is claimed BEFORE delivery, so a
// transient push-service outage could eat one notification rather
// than double-send later. For reminders (all of which re-evaluate
// daily and escalate) a rare miss is better than any double-send.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendWebPush, vapidFromEnv, type PushSubscriptionRecord } from './web-push';

export interface BusinessNotification {
  /** Rule family, e.g. 'quote-promise', 'lead-arrived', 'morning-digest'. */
  ruleKey: string;
  /** Once-only key within the rule, e.g. `${jobId}:2026-08-14:t1`. */
  dedupeKey: string;
  title: string;
  body?: string;
  /** In-app path opened on tap. Defaults to '/home' in the service worker. */
  url?: string;
  /** Notifications sharing a tag replace each other (used by the digest). */
  tag?: string;
}

export interface NotifyResult {
  sent: number;
  /** Why nothing was sent, when nothing was. */
  skipped: 'no-vapid' | 'no-subscriptions' | 'already-sent' | null;
  pruned: number;
}

export async function sendBusinessNotification(
  admin: SupabaseClient,
  businessId: string,
  n: BusinessNotification,
): Promise<NotifyResult> {
  const vapid = vapidFromEnv();
  if ('error' in vapid) return { sent: 0, skipped: 'no-vapid', pruned: 0 };

  // 1. Subscriptions first — see header for why.
  const { data: subs, error: subsErr } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('business_id', businessId);
  if (subsErr) throw new Error(`push_subscriptions read failed: ${subsErr.message}`);
  if (!subs || subs.length === 0) return { sent: 0, skipped: 'no-subscriptions', pruned: 0 };

  // 2. Claim the dedupe key.
  const { data: claimed, error: claimErr } = await admin
    .from('notification_log')
    .insert({
      business_id: businessId,
      rule_key: n.ruleKey,
      dedupe_key: n.dedupeKey,
      title: n.title,
      body: n.body ?? null,
      url: n.url ?? null,
    })
    .select('id');
  if (claimErr) {
    // 23505 = unique violation would normally be swallowed by
    // `on conflict`, but supabase-js has no onConflict-ignore for
    // insert…select, so treat it as "already sent" if it surfaces.
    if (claimErr.code === '23505') return { sent: 0, skipped: 'already-sent', pruned: 0 };
    throw new Error(`notification_log claim failed: ${claimErr.message}`);
  }
  if (!claimed || claimed.length === 0) return { sent: 0, skipped: 'already-sent', pruned: 0 };

  // 3. Fan out.
  let sent = 0;
  const dead: string[] = [];
  for (const s of subs) {
    const rec: PushSubscriptionRecord = { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth };
    try {
      const res = await sendWebPush(rec, { title: n.title, body: n.body, url: n.url, tag: n.tag }, vapid);
      if (res.ok) sent++;
      else if (res.gone) dead.push(s.id as string);
      else console.error(`[push] send failed ${res.status} for ${s.endpoint.slice(0, 60)}…`);
    } catch (e) {
      console.error('[push] send threw:', e);
    }
  }
  if (dead.length > 0) {
    await admin.from('push_subscriptions').delete().in('id', dead);
  }
  return { sent, skipped: null, pruned: dead.length };
}

/**
 * Never-throwing wrapper for use inside webhooks — a push failure must
 * not fail the pipeline that just captured a lead (mirrors the
 * "attachments are best-effort" rule in inbound-email-lead).
 */
export async function sendBusinessNotificationSafe(
  admin: SupabaseClient,
  businessId: string,
  n: BusinessNotification,
): Promise<NotifyResult> {
  try {
    return await sendBusinessNotification(admin, businessId, n);
  } catch (e) {
    console.error('[push] notification failed (non-fatal):', e);
    return { sent: 0, skipped: null, pruned: 0 };
  }
}
