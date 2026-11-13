import { AppError } from './rules.mjs';
import { hashKey } from './auth.mjs';
import { encodePushEvent, encryptWebPush, importPayloadPublicKey, validatePayloadKeys } from './webpush-payload.mjs';

const DAY = 24 * 60 * 60_000;
const SUBSCRIPTION_MS = 180 * DAY;
const MAX_DEVICES = 10;
const JWT_REFRESH_MS = 60 * 60_000;
const encoder = new TextEncoder();
const authorizationCache = new Map();
const invalidSubscription = () => new AppError(400, 'INVALID_PUSH_SUBSCRIPTION', 'Bildirim kaydı doğrulanamadı. Bildirimleri yeniden açın.');
const notConfigured = () => new AppError(503, 'PUSH_NOT_CONFIGURED', 'Telefon bildirimleri henüz kullanıma hazır değil.');

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw notConfigured();
  try {
    const raw = value.replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(atob(raw + '='.repeat((4 - raw.length % 4) % 4)), character => character.charCodeAt(0));
  } catch { throw notConfigured(); }
}

function configuration(env) {
  try {
    const publicKey = env.VAPID_PUBLIC_KEY;
    const privateKey = env.VAPID_PRIVATE_KEY;
    const subject = env.VAPID_SUBJECT;
    if (typeof publicKey !== 'string' || publicKey.length !== 87
      || typeof privateKey !== 'string' || privateKey.length < 100 || privateKey.length > 512
      || typeof subject !== 'string' || subject.length > 254 || !/^mailto:[^\s@<>]+@[^\s@<>]+$/.test(subject)
      || !/^[a-f0-9]{64}$/.test(env.DOCTOR_KEY_HASH || '')) return null;
    const publicBytes = decode(publicKey);
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || decode(privateKey).length < 70) return null;
    return { publicKey, privateKey, subject, version: env.DOCTOR_KEY_HASH };
  } catch { return null; }
}

export function pushConfiguration(env) {
  const config = configuration(env);
  return { enabled: Boolean(config), applicationServerKey: config?.publicKey || null };
}

function requiredConfiguration(env) {
  const config = configuration(env);
  if (!config) throw notConfigured();
  return config;
}

/** Only browser push providers can receive server requests; endpoints stay opaque. */
export function validatePushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()) throw invalidSubscription();
  let url;
  try { url = new URL(value); } catch { throw invalidSubscription(); }
  const apple = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+push\.apple\.com$/.test(url.hostname);
  const provider = apple || ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname);
  if (!provider || url.protocol !== 'https:' || url.port || url.username || url.password
    || url.search || url.hash || url.pathname === '/' || url.href !== value) throw invalidSubscription();
  return url.href;
}

export function validatePushSubscription(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidSubscription();
  const endpoint = validatePushEndpoint(body.endpoint);
  const expirationTime = body.expirationTime ?? null;
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)) throw invalidSubscription();
  // Endpoint-only clients remain compatible. An explicit partial/malformed key
  // pair must fail rather than silently remove the device's encryption keys.
  if (body.keys === undefined) return { endpoint, expirationTime };
  try { return { endpoint, expirationTime, ...validatePayloadKeys(body.keys) }; }
  catch { throw invalidSubscription(); }
}

/** RFC 8292 ES256 JWT, usable only for the destination provider's HTTPS origin. */
export async function createVapidAuthorization(endpoint, env, now = Date.now()) {
  const origin = new URL(validatePushEndpoint(endpoint)).origin;
  const config = requiredConfiguration(env);
  const cacheId = `${config.publicKey}\0${config.subject}\0${origin}`;
  const cached = authorizationCache.get(cacheId);
  if (cached && now >= cached.created && now - cached.created < JWT_REFRESH_MS) return cached.promise;
  const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64url(encoder.encode(JSON.stringify({ aud: origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: config.subject })));
  const unsigned = `${header}.${claims}`;
  const promise = (async () => { try {
    const key = await crypto.subtle.importKey('pkcs8', decode(config.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
    const publicKey = await crypto.subtle.importKey('raw', decode(config.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, encoder.encode(unsigned))) throw notConfigured();
    const value = `vapid t=${unsigned}.${base64url(signature)}, k=${config.publicKey}`;
    // There are at most a handful of provider origins, and no endpoint or secret
    // is part of the cache key. Bound the cache across configuration rotations.
    return value;
  } catch { throw notConfigured(); } })();
  if (authorizationCache.size >= 20) authorizationCache.clear();
  const entry = { created: now, promise };
  authorizationCache.set(cacheId, entry);
  try { return await promise; }
  catch (error) {
    if (authorizationCache.get(cacheId) === entry) authorizationCache.delete(cacheId);
    throw error;
  }
}

export class PushStore {
  constructor(db, clock = () => Date.now()) { this.db = db; this.clock = clock; }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }

  async subscribe(body, env, sessionHash) {
    const config = requiredConfiguration(env);
    const subscription = validatePushSubscription(body);
    if (subscription.p256dh) {
      try { await importPayloadPublicKey(subscription.p256dh); }
      catch { throw invalidSubscription(); }
    }
    if (!/^[a-f0-9]{64}$/.test(sessionHash || '')) throw invalidSubscription();
    const now = this.clock();
    const expires = Math.min(subscription.expirationTime ?? Infinity, now + SUBSCRIPTION_MS);
    if (expires <= now) throw invalidSubscription();
    const hash = await hashKey(subscription.endpoint);
    // A single conditional write enforces the device cap even if subscriptions
    // are added concurrently. Re-enabling the same device is idempotent.
    const result = await this.statement(`INSERT INTO doctor_push_subscriptions
      (hash,endpoint,credential_version,vapid_public_key,session_hash,created,updated,expires,p256dh,auth)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM doctor_push_subscriptions WHERE credential_version=? AND vapid_public_key=? AND expires>?)<?
      OR EXISTS(SELECT 1 FROM doctor_push_subscriptions WHERE hash=? AND credential_version=? AND vapid_public_key=? AND expires>?)
      ON CONFLICT(hash) DO UPDATE SET endpoint=excluded.endpoint,credential_version=excluded.credential_version,
      vapid_public_key=excluded.vapid_public_key,session_hash=excluded.session_hash,updated=excluded.updated,expires=excluded.expires,
      p256dh=COALESCE(excluded.p256dh,doctor_push_subscriptions.p256dh),auth=COALESCE(excluded.auth,doctor_push_subscriptions.auth)`,
    hash, subscription.endpoint, config.version, config.publicKey, sessionHash, now, now, expires, subscription.p256dh ?? null, subscription.auth ?? null,
    config.version, config.publicKey, now, MAX_DEVICES, hash, config.version, config.publicKey, now).run();
    if (!result.meta?.changes) throw new AppError(409, 'PUSH_DEVICE_LIMIT', 'En fazla 10 cihazda bildirim açılabilir. Kullanmadığınız bir cihazda bildirimleri kapatın.');
    return { subscribed: true };
  }

  async unsubscribe(endpoint, env, sessionHash) {
    const config = requiredConfiguration(env);
    const hash = await hashKey(validatePushEndpoint(endpoint));
    // A renewed physician session can still disable its known device endpoint.
    // This single-physician app never lists endpoints; the credential and VAPID
    // boundaries remain in place even when the eight-hour login has changed.
    await this.statement('DELETE FROM doctor_push_subscriptions WHERE hash=? AND credential_version=? AND vapid_public_key=?',
      hash, config.version, config.publicKey).run();
    return { subscribed: false };
  }

  async removeSession(sessionHash, env) {
    if (!/^[a-f0-9]{64}$/.test(env.DOCTOR_KEY_HASH || '')) return;
    await this.statement('DELETE FROM doctor_push_subscriptions WHERE session_hash=? AND credential_version=?', sessionHash, env.DOCTOR_KEY_HASH).run();
  }

  async count(env) {
    const config = configuration(env);
    if (!config) return 0;
    const row = await this.statement('SELECT COUNT(*) AS count FROM doctor_push_subscriptions WHERE credential_version=? AND vapid_public_key=? AND expires>?',
      config.version, config.publicKey, this.clock()).first();
    return row?.count || 0;
  }

  async sendRows(rows, env, { fetcher = fetch, event } = {}) {
    const summary = { configured: true, attempted: rows.length, accepted: 0, removed: 0, failed: 0 };
    await Promise.all(rows.map(async row => {
      let timer;
      try {
        const endpoint = validatePushEndpoint(row.endpoint);
        const authorization = await createVapidAuthorization(endpoint, env, this.clock());
        const headers = { Authorization: authorization, TTL: '300', Urgency: 'high', 'Content-Length': '0' };
        let body;
        // Old devices retain generic notifications until their next automatic
        // authenticated renewal supplies keys. Invalid events/keys never become
        // plaintext; failed encryption counts as a failed best-effort delivery.
        if (event !== undefined) {
          const plaintext = encodePushEvent(event);
          if (row.p256dh !== null && row.p256dh !== undefined || row.auth !== null && row.auth !== undefined) {
            body = await encryptWebPush(plaintext, { p256dh: row.p256dh, auth: row.auth });
            headers['Content-Encoding'] = 'aes128gcm';
            headers['Content-Type'] = 'application/octet-stream';
            headers['Content-Length'] = String(body.byteLength);
          }
        }
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 8_000);
        const response = await fetcher(endpoint, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers, ...(body ? { body } : {}),
        });
        // Never log or return the opaque endpoint, response body, JWT or keys.
        if (response.status >= 200 && response.status < 300) summary.accepted++;
        else if (response.status === 404 || response.status === 410) {
          // A late provider rejection belongs to the snapshot that was sent.
          // Renewals may share the same millisecond but replace keys or owner;
          // do not delete that newer subscription in response to the old send.
          const removed = await this.statement(`DELETE FROM doctor_push_subscriptions
            WHERE hash=? AND endpoint=? AND updated=? AND created=? AND expires=?
            AND credential_version=? AND vapid_public_key=? AND session_hash=?
            AND p256dh IS ? AND auth IS ?`,
          row.hash, row.endpoint, row.updated, row.created, row.expires,
          row.credential_version, row.vapid_public_key, row.session_hash,
          row.p256dh ?? null, row.auth ?? null).run();
          if (removed.meta?.changes) summary.removed++;
          else summary.failed++;
        } else summary.failed++;
        try { await response.body?.cancel(); } catch { /* Delivery status is already known. */ }
      } catch { summary.failed++; }
      finally { clearTimeout(timer); }
    }));
    return summary;
  }

  /** Best-effort delivery must never turn a saved employee request into an error. */
  async sendAll(env, options = {}) {
    const config = configuration(env);
    if (!config) return { configured: false, attempted: 0, accepted: 0, removed: 0, failed: 0 };
    try {
      const { results } = await this.statement(`SELECT hash,endpoint,updated,created,expires,credential_version,vapid_public_key,session_hash,p256dh,auth FROM doctor_push_subscriptions
        WHERE credential_version=? AND vapid_public_key=? AND expires>? ORDER BY updated DESC LIMIT ?`,
      config.version, config.publicKey, this.clock(), MAX_DEVICES).all();
      return await this.sendRows(results, env, options);
    } catch { return { configured: true, attempted: 0, accepted: 0, removed: 0, failed: 1 }; }
  }

  async test(endpoint, env, sessionHash, options = {}) {
    const config = requiredConfiguration(env);
    const hash = await hashKey(validatePushEndpoint(endpoint));
    const row = await this.statement(`SELECT hash,endpoint,updated,created,expires,credential_version,vapid_public_key,session_hash,p256dh,auth FROM doctor_push_subscriptions
      WHERE hash=? AND credential_version=? AND vapid_public_key=? AND session_hash=? AND expires>?`,
    hash, config.version, config.publicKey, sessionHash, this.clock()).first();
    if (!row) throw new AppError(404, 'PUSH_SUBSCRIPTION_NOT_FOUND', 'Bu cihazda bildirimler açık değil. Önce bildirimleri açın.');
    return this.sendRows([row], env, options);
  }

  async cleanup(env) {
    const config = configuration(env);
    if (!config) {
      await this.statement('DELETE FROM doctor_push_subscriptions WHERE expires<=?', this.clock()).run();
      return;
    }
    await this.statement('DELETE FROM doctor_push_subscriptions WHERE expires<=? OR credential_version<>? OR vapid_public_key<>?',
      this.clock(), config.version, config.publicKey).run();
  }
}
