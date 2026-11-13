import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashKey } from '../src/auth.mjs';
import { PushStore, createVapidAuthorization, pushConfiguration, validatePushEndpoint, validatePushSubscription } from '../src/push.mjs';
import { createD1Fixture } from './d1-fixture.mjs';

const APPLE = 'https://web.push.apple.com/QExampleToken';
const MOZILLA = 'https://updates.push.services.mozilla.com/wpush/v2/ExampleToken';
const GOOGLE = 'https://fcm.googleapis.com/wp/ExampleToken';
const DAY = 24 * 60 * 60_000;
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const unb64 = value => Buffer.from(value, 'base64url');
const rejected = (code, status) => error => { assert.equal(error.code, code); assert.equal(error.status, status); return true; };

async function vapidEnv() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    VAPID_PUBLIC_KEY: b64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    VAPID_PRIVATE_KEY: b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    VAPID_SUBJECT: 'mailto:doctor@example.test', DOCTOR_KEY_HASH: await hashKey('test-credential-version'),
  };
}

async function fixture(t) {
  const f = await createD1Fixture();
  t.after(() => f.dispose());
  return { ...f, env: await vapidEnv(), session: await hashKey('server-authenticated-session'), other: await hashKey('another-session'), push: new PushStore(f.db, () => f.clock.value) };
}

test('push configuration exposes only the public key and fails closed when incomplete', async () => {
  const env = await vapidEnv();
  assert.deepEqual(pushConfiguration(env), { enabled: true, applicationServerKey: env.VAPID_PUBLIC_KEY });
  for (const partial of [{}, { ...env, VAPID_PRIVATE_KEY: '' }, { ...env, VAPID_PUBLIC_KEY: 'not-a-key' }, { ...env, VAPID_SUBJECT: 'mailto:a\r\nb@example.test' }, { ...env, DOCTOR_KEY_HASH: '123456' }]) {
    assert.deepEqual(pushConfiguration(partial), { enabled: false, applicationServerKey: null });
  }
  const json = JSON.stringify(pushConfiguration(env));
  assert.equal(json.includes(env.VAPID_PRIVATE_KEY), false);
  assert.equal(json.includes(env.DOCTOR_KEY_HASH), false);
});

test('only canonical HTTPS provider endpoints pass the SSRF boundary', () => {
  for (const endpoint of [APPLE, MOZILLA, GOOGLE, 'https://another.push.apple.com/opaque%2Ftoken']) assert.equal(validatePushEndpoint(endpoint), endpoint);
  for (const endpoint of [
    'http://web.push.apple.com/abc', 'https://127.0.0.1/private', 'https://localhost/abc', 'https://[::1]/abc',
    'https://evil.example/abc', 'https://web.push.apple.com.attacker.test/abc', 'https://evilpush.apple.com/abc',
    'https://web.push.apple.com:443/abc', 'https://web.push.apple.com:8080/abc', 'https://name@web.push.apple.com/abc',
    'https://web.push.apple.com/abc?redirect=https://attacker.test', 'https://web.push.apple.com/abc#fragment',
    'https://web.push.apple.com/', ' https://web.push.apple.com/abc', 'https://web.push.apple.com/../abc',
    'https://WEB.push.apple.com/abc', 'https://web.push.apple.com\\@attacker.test/abc',
  ]) assert.throws(() => validatePushEndpoint(endpoint), rejected('INVALID_PUSH_SUBSCRIPTION', 400));
  assert.deepEqual(validatePushSubscription({ endpoint: APPLE }), { endpoint: APPLE, expirationTime: null });
  assert.throws(() => validatePushSubscription({ endpoint: APPLE, keys: { p256dh: 'invalid', auth: 'invalid' } }), rejected('INVALID_PUSH_SUBSCRIPTION', 400));
  for (const body of [null, [], { endpoint: APPLE, expirationTime: -1 }, { endpoint: APPLE, expirationTime: '12' }]) assert.throws(() => validatePushSubscription(body), rejected('INVALID_PUSH_SUBSCRIPTION', 400));
});

test('VAPID has a verifiable ES256 signature, provider audience and a twelve-hour lifetime', async () => {
  const env = await vapidEnv();
  const now = Date.parse('2026-10-16T12:34:56Z');
  const authorization = await createVapidAuthorization(APPLE, env, now);
  const match = /^vapid t=([^, ]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
  assert.ok(match);
  assert.equal(match[2], env.VAPID_PUBLIC_KEY);
  const [header, payload, signature] = match[1].split('.');
  assert.deepEqual(JSON.parse(unb64(header)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(unb64(payload)), { aud: 'https://web.push.apple.com', exp: Math.floor(now / 1000) + 43_200, sub: env.VAPID_SUBJECT });
  assert.equal(unb64(signature).length, 64, 'JWT uses raw IEEE-P1363 ES256 bytes, not ASN.1 DER');
  const publicKey = await crypto.subtle.importKey('raw', unb64(env.VAPID_PUBLIC_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, unb64(signature), new TextEncoder().encode(`${header}.${payload}`)), true);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, unb64(signature), new TextEncoder().encode(`${header}.altered`)), false);
  const parallel = await Promise.all(Array.from({ length: 10 }, () => createVapidAuthorization(`${APPLE}2`, env, now + 1)));
  assert.equal(parallel.every(value => value === authorization), true, 'one cached JWT is reused for same provider for an hour');
  assert.equal(await createVapidAuthorization(APPLE, env, now + 3_599_999), authorization);
  assert.notEqual(await createVapidAuthorization(APPLE, env, now + 3_600_000), authorization);
  const googleToken = await createVapidAuthorization(GOOGLE, env, now);
  assert.equal(JSON.parse(unb64(googleToken.split('t=')[1].split('.')[1])).aud, 'https://fcm.googleapis.com');
});

test('mismatched or invalid VAPID private keys fail before any notification can be sent', async () => {
  const env = await vapidEnv();
  const other = await vapidEnv();
  await assert.rejects(createVapidAuthorization(APPLE, { ...env, VAPID_PRIVATE_KEY: other.VAPID_PRIVATE_KEY }), rejected('PUSH_NOT_CONFIGURED', 503));
  await assert.rejects(createVapidAuthorization(APPLE, { ...env, VAPID_PRIVATE_KEY: 'A'.repeat(180) }), rejected('PUSH_NOT_CONFIGURED', 503));
});

test('subscriptions are idempotent and credential-bound; validated encryption keys survive endpoint-only renewals without personal fields', async t => {
  const f = await fixture(t);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
  assert.deepEqual(await f.push.subscribe({ endpoint: APPLE, keys, fullName: 'must-not-be-retained' }, f.env, f.session), { subscribed: true });
  f.clock.value += 1000;
  await f.push.subscribe({ endpoint: APPLE }, f.env, f.other);
  const rows = (await f.db.prepare('SELECT * FROM doctor_push_subscriptions').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, await hashKey(APPLE));
  assert.equal(rows[0].session_hash, f.other);
  assert.equal(rows[0].credential_version, f.env.DOCTOR_KEY_HASH);
  assert.equal(rows[0].expires, f.clock.value + 180 * DAY);
  assert.equal(rows[0].p256dh, keys.p256dh);
  assert.equal(rows[0].auth, keys.auth);
  assert.equal(JSON.stringify(rows).includes('must-not-be-retained'), false);
  assert.equal(Object.hasOwn(rows[0], 'keys'), false);
  assert.equal(await f.push.count(f.env), 1);
  await f.push.removeSession(f.session, f.env);
  assert.equal(await f.push.count(f.env), 1, 'logout from an old session cannot remove a reattached current subscription');
  await f.push.removeSession(f.other, { DOCTOR_KEY_HASH: f.env.DOCTOR_KEY_HASH });
  assert.equal(await f.push.count(f.env), 0);
});

test('malformed or off-curve payload keys cannot register a device or overwrite its valid keys', async t => {
  const f = await fixture(t);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
  await f.push.subscribe({ endpoint: APPLE, keys }, f.env, f.session);
  const offCurve = new Uint8Array(65); offCurve[0] = 4;
  for (const invalid of [{ auth: keys.auth }, { ...keys, auth: keys.auth + '=' }, { ...keys, p256dh: b64(offCurve) }, null]) {
    await assert.rejects(f.push.subscribe({ endpoint: APPLE, keys: invalid }, f.env, f.session), rejected('INVALID_PUSH_SUBSCRIPTION', 400));
  }
  const row = await f.db.prepare('SELECT p256dh,auth FROM doctor_push_subscriptions').first();
  assert.deepEqual(row, keys);
});

test('the ten-device cap is atomic, and re-enabling an existing active device remains possible', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 15 }, (_, index) => f.push.subscribe({ endpoint: `${APPLE}${index}` }, f.env, f.session)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 10);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'PUSH_DEVICE_LIMIT').length, 5);
  assert.equal(await f.push.count(f.env), 10);
  const row = await f.db.prepare('SELECT endpoint FROM doctor_push_subscriptions LIMIT 1').first();
  await f.push.subscribe({ endpoint: row.endpoint }, f.env, f.other);
  assert.equal(await f.push.count(f.env), 10);
  await assert.rejects(f.push.subscribe({ endpoint: APPLE, expirationTime: f.clock.value }, f.env, f.session), rejected('INVALID_PUSH_SUBSCRIPTION', 400));
});

test('notification POSTs have no payload, safe headers and no redirect following', async t => {
  const f = await fixture(t);
  await f.push.subscribe({ endpoint: APPLE }, f.env, f.session);
  let called = 0;
  const result = await f.push.sendAll(f.env, { fetcher: async (endpoint, options) => {
    called++;
    assert.equal(endpoint, APPLE);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.TTL, '300');
    assert.equal(options.headers.Urgency, 'high');
    assert.equal(options.headers['Content-Length'], '0');
    assert.match(options.headers.Authorization, /^vapid t=/);
    assert.equal(Object.hasOwn(options.headers, 'Content-Encoding'), false);
    assert.ok(options.signal);
    return new Response(null, { status: 201 });
  } });
  assert.equal(called, 1);
  assert.deepEqual(result, { configured: true, attempted: 1, accepted: 1, removed: 0, failed: 0 });
  assert.equal(JSON.stringify(result).includes(APPLE), false);
  assert.equal(JSON.stringify(result).includes(f.env.VAPID_PRIVATE_KEY), false);
});

test('coded notifications send only aes128gcm encrypted bytes while legacy devices retain generic delivery', async t => {
  const f = await fixture(t);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
  await f.push.subscribe({ endpoint: APPLE, keys }, f.env, f.session);
  await f.push.subscribe({ endpoint: MOZILLA }, f.env, f.session);
  const event = { type: 'waiting', code: 'Cum-19', day: '2026-10-16' };
  let encrypted = 0; let legacy = 0;
  const result = await f.push.sendAll(f.env, { event, fetcher: async (endpoint, options) => {
    if (endpoint === APPLE) {
      encrypted++;
      assert.ok(options.body instanceof Uint8Array);
      assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      assert.equal(options.headers['Content-Length'], String(options.body.byteLength));
      assert.equal(new DataView(options.body.buffer).getUint32(16, false), 4096);
      assert.equal(options.body[20], 65);
      for (const value of [event.code, event.day, event.type, keys.auth]) assert.equal(Buffer.from(options.body).includes(Buffer.from(value)), false);
    } else {
      legacy++;
      assert.equal(options.body, undefined);
      assert.equal(options.headers['Content-Length'], '0');
      assert.equal(options.headers['Content-Encoding'], undefined);
    }
    return new Response(null, { status: 201 });
  } });
  assert.equal(encrypted, 1); assert.equal(legacy, 1);
  assert.deepEqual(result, { configured: true, attempted: 2, accepted: 2, removed: 0, failed: 0 });
});

test('generic feedback notifications support encrypted and legacy subscriptions without attaching employee content', async t => {
  const f = await fixture(t);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
  await f.push.subscribe({ endpoint: APPLE, keys }, f.env, f.session);
  await f.push.subscribe({ endpoint: MOZILLA }, f.env, f.session);
  let encrypted = 0, legacy = 0;
  const result = await f.push.sendAll(f.env, { event: { type: 'feedback' }, fetcher: async (endpoint, options) => {
    if (endpoint === APPLE) {
      encrypted++;
      assert.ok(options.body instanceof Uint8Array);
      assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
      assert.equal(options.headers['Content-Length'], String(options.body.byteLength));
      assert.equal(Buffer.from(options.body).includes(Buffer.from('feedback')), false);
    } else {
      legacy++;
      assert.equal(options.body, undefined);
      assert.equal(options.headers['Content-Length'], '0');
      assert.equal(options.headers['Content-Encoding'], undefined);
    }
    return new Response(null, { status: 201 });
  } });
  assert.equal(encrypted, 1);
  assert.equal(legacy, 1);
  assert.deepEqual(result, { configured: true, attempted: 2, accepted: 2, removed: 0, failed: 0 });
});

test('encryption failure or an invalid coded event never falls back to plaintext or calls the provider', async t => {
  const f = await fixture(t);
  await f.push.subscribe({ endpoint: APPLE }, f.env, f.session);
  await f.db.prepare('UPDATE doctor_push_subscriptions SET p256dh=?,auth=?').bind('bad-key', 'bad-secret').run();
  let calls = 0;
  const options = { event: { type: 'left', code: 'Cum-19', day: '2026-10-16' }, fetcher() { calls++; throw new Error('provider must not be contacted'); } };
  assert.deepEqual(await f.push.sendAll(f.env, options), { configured: true, attempted: 1, accepted: 0, removed: 0, failed: 1 });
  await f.db.prepare('UPDATE doctor_push_subscriptions SET p256dh=NULL,auth=NULL').run();
  assert.deepEqual(await f.push.sendAll(f.env, { ...options, event: { type: 'left', code: 'Pzt-19', day: '2026-10-16' } }), { configured: true, attempted: 1, accepted: 0, removed: 0, failed: 1 });
  assert.equal(calls, 0);
});

test('payload-key migration preserves the existing subscription and supports its keyless renewal and later encrypted upgrade', async t => {
  const f = await fixture(t);
  await f.db.exec('DROP TABLE doctor_push_subscriptions');
  await f.db.exec('CREATE TABLE doctor_push_subscriptions (hash TEXT PRIMARY KEY,endpoint TEXT NOT NULL,credential_version TEXT NOT NULL,vapid_public_key TEXT NOT NULL,session_hash TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,expires INTEGER NOT NULL)');
  await f.db.prepare('INSERT INTO doctor_push_subscriptions VALUES (?,?,?,?,?,?,?,?)').bind(await hashKey(APPLE), APPLE, f.env.DOCTOR_KEY_HASH, f.env.VAPID_PUBLIC_KEY, f.session, f.clock.value, f.clock.value, f.clock.value + DAY).run();
  const migration = await readFile(new URL('../migrations/0004_push_payload_keys.sql', import.meta.url), 'utf8');
  for (const sql of migration.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await f.db.exec(sql);
  await f.push.subscribe({ endpoint: APPLE }, f.env, f.other);
  const legacy = await f.db.prepare('SELECT * FROM doctor_push_subscriptions').first();
  assert.equal(legacy.endpoint, APPLE); assert.equal(legacy.p256dh, null); assert.equal(legacy.auth, null);
  assert.equal(legacy.session_hash, f.other); assert.equal(await f.push.count(f.env), 1);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
  await f.push.subscribe({ endpoint: APPLE, keys }, f.env, f.other);
  assert.deepEqual(await f.db.prepare('SELECT p256dh,auth FROM doctor_push_subscriptions').first(), keys);
});

test('gone endpoints are removed while throttle, server, redirects and network failures remain nonfatal', async t => {
  const f = await fixture(t);
  const statuses = [404, 410, 429, 503, 307, 'network'];
  for (let index = 0; index < statuses.length; index++) await f.push.subscribe({ endpoint: `${APPLE}${index}` }, f.env, f.session);
  const result = await f.push.sendAll(f.env, { fetcher: async endpoint => {
    const status = statuses[Number(endpoint.at(-1))];
    if (status === 'network') throw new Error(`must not leak ${endpoint}`);
    return new Response(null, { status, headers: status === 307 ? { location: 'https://127.0.0.1/private' } : {} });
  } });
  assert.deepEqual(result, { configured: true, attempted: 6, accepted: 0, removed: 2, failed: 4 });
  assert.equal(await f.push.count(f.env), 4);
  assert.equal(JSON.stringify(result).includes(APPLE), false);
  assert.deepEqual(await f.push.sendAll({}, { fetcher: () => { throw new Error('not called'); } }), { configured: false, attempted: 0, accepted: 0, removed: 0, failed: 0 });
  const unavailable = new PushStore({ prepare() { throw new Error('database unavailable'); } });
  assert.deepEqual(await unavailable.sendAll(f.env), { configured: true, attempted: 0, accepted: 0, removed: 0, failed: 1 });
});

test('a stale gone response cannot remove a same-millisecond renewed subscription with new keys or ownership', async t => {
  const f = await fixture(t);
  const keyPair = async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return { p256dh: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
  };
  const keys = await keyPair(), renewedKeys = await keyPair();
  await f.push.subscribe({ endpoint: APPLE, keys }, f.env, f.session);
  const before = await f.db.prepare('SELECT updated FROM doctor_push_subscriptions').first();
  const result = await f.push.sendAll(f.env, { event: { type: 'feedback' }, fetcher: async () => {
    await f.push.subscribe({ endpoint: APPLE, keys: renewedKeys }, f.env, f.other);
    assert.equal((await f.db.prepare('SELECT updated FROM doctor_push_subscriptions').first()).updated, before.updated);
    return new Response(null, { status: 410 });
  } });
  assert.equal(await f.push.count(f.env), 1, 'the late failure belongs to the old subscription snapshot');
  assert.deepEqual(await f.db.prepare('SELECT p256dh,auth,session_hash FROM doctor_push_subscriptions').first(), { ...renewedKeys, session_hash: f.other });
  assert.deepEqual(result, { configured: true, attempted: 1, accepted: 0, removed: 0, failed: 1 });
});

test('a renewed physician session can disable its known endpoint, while test and credential boundaries remain', async t => {
  const f = await fixture(t);
  await f.push.subscribe({ endpoint: APPLE }, f.env, f.session);
  await assert.rejects(f.push.test(APPLE, f.env, f.other, { fetcher: () => { throw new Error('not called'); } }), rejected('PUSH_SUBSCRIPTION_NOT_FOUND', 404));
  await f.push.unsubscribe(APPLE + '-other-device', f.env, f.other);
  await f.push.unsubscribe(APPLE, { ...f.env, DOCTOR_KEY_HASH: await hashKey('rotated-credential') }, f.other);
  await f.push.unsubscribe(APPLE, { ...await vapidEnv(), DOCTOR_KEY_HASH: f.env.DOCTOR_KEY_HASH }, f.other);
  assert.equal(await f.push.count(f.env), 1);
  const result = await f.push.test(APPLE, f.env, f.session, { fetcher: async () => new Response(null, { status: 201 }) });
  assert.equal(result.accepted, 1);
  await f.push.unsubscribe(APPLE, f.env, f.other);
  assert.equal(await f.push.count(f.env), 0);
});

test('credential rotation, VAPID rotation and subscription expiry prevent sending and cleanup removes stale rows', async t => {
  const f = await fixture(t);
  await f.push.subscribe({ endpoint: APPLE, expirationTime: f.clock.value + 1000 }, f.env, f.session);
  const rotatedCredential = { ...f.env, DOCTOR_KEY_HASH: await hashKey('rotated-credential') };
  const rotatedVapid = { ...await vapidEnv(), DOCTOR_KEY_HASH: f.env.DOCTOR_KEY_HASH };
  for (const env of [rotatedCredential, rotatedVapid]) {
    assert.equal(await f.push.count(env), 0);
    assert.equal((await f.push.sendAll(env, { fetcher: () => { throw new Error('not called'); } })).attempted, 0);
  }
  f.clock.value += 1000;
  assert.equal((await f.push.sendAll(f.env)).attempted, 0);
  await f.push.cleanup({});
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_push_subscriptions').first()).count, 0);
  await f.push.subscribe({ endpoint: APPLE }, f.env, f.session);
  await f.push.cleanup(rotatedCredential);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_push_subscriptions').first()).count, 0);
});
