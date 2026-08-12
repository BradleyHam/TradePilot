// =============================================================
// Web Push sender — VAPID (RFC 8292) + aes128gcm payload
// encryption (RFC 8291 / RFC 8188), dependency-free
// =============================================================
//
// Sends a push message to a browser push endpoint (Apple/Google/Mozilla
// push services) using only node:crypto + fetch. SERVER-SIDE ONLY —
// needs the VAPID private key.
//
// Why we hand-roll instead of `npm install web-push`:
//
//   - Same reason as lib/zip-download.ts and lib/ics.ts: npm installs
//     inside the agent workspace break the Mac's esbuild binary (see
//     AGENTS.md gotchas), and the protocol is stable — both RFCs are
//     from 2016-2018 and the push services are strict about them, so
//     there's nothing to track.
//   - The whole thing is ~120 lines of well-specified crypto that
//     node:crypto covers natively (ECDH P-256, HKDF-SHA256,
//     AES-128-GCM, ES256 signing).
//   - It's verifiable: `scripts/test-web-push-crypto.ts` checks the
//     encryption against the official RFC 8291 Appendix A test vector
//     byte-for-byte. If that passes, Apple/Google will accept it.
//
// Env vars used by the convenience wrapper `vapidFromEnv()`:
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY — base64url, 65-byte uncompressed
//     P-256 point. Public: also used by the browser to subscribe.
//   VAPID_PRIVATE_KEY            — base64url, 32-byte P-256 scalar.
//   VAPID_SUBJECT                — mailto: contact, sent to the push
//     service so they can reach us if our sender misbehaves.

import crypto from 'node:crypto';

export interface PushSubscriptionRecord {
  endpoint: string;
  /** base64url — client public key from PushSubscription.getKey('p256dh'). */
  p256dh: string;
  /** base64url — 16-byte auth secret from PushSubscription.getKey('auth'). */
  auth: string;
}

export interface VapidKeys {
  publicKey: string;   // base64url uncompressed point
  privateKey: string;  // base64url scalar
  subject: string;     // 'mailto:...'
}

/** The JSON contract with public/sw.js — keep the two in sync. */
export interface PushPayload {
  title: string;
  body?: string;
  /** In-app path to open on tap, e.g. '/home' or '/leads'. */
  url?: string;
  /** Same tag replaces rather than stacks (used by the daily digest). */
  tag?: string;
}

export function vapidFromEnv(): VapidKeys | { error: string } {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return { error: 'Missing VAPID env vars (NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT).' };
  }
  return { publicKey, privateKey, subject };
}

// ── VAPID auth header (RFC 8292) ───────────────────────────────────────────
//
// A short-lived ES256 JWT proving we hold the private key matching the
// public key the browser subscribed with. `aud` is the push service
// ORIGIN (not the full endpoint), per spec.

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function vapidAuthHeader(endpoint: string, keys: VapidKeys): string {
  const { origin } = new URL(endpoint);
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: origin,
    // 12h expiry — max the spec allows is 24h; half that leaves slack
    // for clock skew without minting a fresh JWT per send.
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: keys.subject,
  })));
  const unsigned = `${header}.${claims}`;

  // Reassemble a signing key from the raw scalar + point via JWK — the
  // only dependency-free way to load raw EC key material into node.
  const pub = Buffer.from(keys.publicKey, 'base64url'); // 0x04 || x || y
  const signingKey = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
  // JOSE wants the raw r||s signature, not DER — hence ieee-p1363.
  const sig = crypto.sign('sha256', Buffer.from(unsigned), {
    key: signingKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ── Payload encryption (RFC 8291, content coding aes128gcm) ────────────────
//
// One record, one message. Key schedule, straight from the RFC:
//
//   ecdh_secret = ECDH(as_private, ua_public)
//   IKM  = HKDF(salt=auth_secret, ikm=ecdh_secret,
//                info="WebPush: info" || 0x00 || ua_public || as_public, 32)
//   CEK  = HKDF(salt, IKM, "Content-Encoding: aes128gcm" || 0x00, 16)
//   NONCE= HKDF(salt, IKM, "Content-Encoding: nonce"     || 0x00, 12)
//   body = salt(16) || rs(4) || keyid_len(1) || as_public(65) || AES-GCM(record)
//
// where record = plaintext || 0x02 (the last-record padding delimiter).
//
// `testKeys` exists so the RFC test vector (fixed ephemeral key + salt)
// can drive the exact same code path production uses.

export function encryptPayload(
  plaintext: Buffer,
  sub: PushSubscriptionRecord,
  testKeys?: { asPrivate: Buffer; salt: Buffer },
): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Subscription p256dh is not a 65-byte uncompressed P-256 point.');
  }
  if (authSecret.length !== 16) {
    throw new Error('Subscription auth secret is not 16 bytes.');
  }

  const as = crypto.createECDH('prime256v1');
  if (testKeys) as.setPrivateKey(testKeys.asPrivate);
  else as.generateKeys();
  const asPublic = as.getPublicKey(); // 65-byte uncompressed
  const ecdhSecret = as.computeSecret(uaPublic);
  const salt = testKeys ? testKeys.salt : crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // Header block: salt, record size (4096 — plenty; one record anyway),
  // then our ephemeral public key as the keyid.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

// ── Send ───────────────────────────────────────────────────────────────────

export interface PushSendResult {
  ok: boolean;
  status: number;
  /**
   * 404/410 means the subscription is dead (app deleted, permission
   * revoked, iOS evicted it) — the caller should delete the row.
   */
  gone: boolean;
}

export async function sendWebPush(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
  vapid: VapidKeys,
): Promise<PushSendResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), sub);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      // A day: reminders older than that are stale — the next cron run
      // will have re-evaluated the world anyway.
      ttl: '86400',
      urgency: 'normal',
      authorization: vapidAuthHeader(sub.endpoint, vapid),
    },
    body: new Uint8Array(body),
  });
  // Push services return 201 on accept; treat any 2xx as fine.
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
