import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DoctorAuth, hashKey, hashPassword, requireSameOrigin, verifyCsrf } from './auth.mjs';
import { createD1Fixture } from '../test/d1-fixture.mjs';

const SECRET = '862493'; // Synthetic PIN, unrelated to the deployed credential.
const LEGACY_SECRET = 'a_test_only_32_byte_high_entropy_format_value_0123456789';
const PEPPER = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');
const ORIGIN = 'https://revir-test.workers.dev';
const FIVE_MINUTES = 5 * 60_000;
const EIGHT_HOURS = 8 * 60 * 60_000;

function rejected(code, status) {
  return error => { assert.equal(error.code, code); assert.equal(error.status, status); return true; };
}
function cookiePair(cookie) { return cookie.split(';', 1)[0]; }
function authRequest(pair, csrf, more = {}) {
  return new Request(`${ORIGIN}/api/doctor/login`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: pair, 'x-csrf-token': csrf, 'cf-connecting-ip': '192.0.2.12', ...more },
  });
}
async function fixture(t, { password = SECRET, pepper = PEPPER } = {}) {
  const f = await createD1Fixture();
  t.after(() => f.dispose());
  const env = { DOCTOR_KEY_HASH: pepper === null ? await hashKey(password) : await hashPassword(password, pepper),
    DOCTOR_EMAIL: 'hekim@ornek-kurum.example', ...(pepper === null ? {} : { DOCTOR_KEY_PEPPER: pepper }) };
  const auth = new DoctorAuth(f.db, () => f.clock.value);
  const initial = await auth.preauth(new Request(`${ORIGIN}/api/doctor/session`), env);
  const pair = cookiePair(initial.cookie);
  return { ...f, env, auth, initial, pair, request: (headers = {}) => authRequest(pair, initial.session.csrf, headers) };
}

test('unconfigured credentials fail closed before the database is read', async () => {
  let touched = false;
  const auth = new DoctorAuth({ prepare() { touched = true; throw Error('must not run'); } });
  const request = new Request(`${ORIGIN}/api/doctor/session`);
  for (const value of [undefined, '', SECRET, 'A'.repeat(64), 'x'.repeat(64)]) {
    const env = { DOCTOR_KEY_HASH: value };
    await assert.rejects(auth.session(request, env), rejected('DOCTOR_NOT_CONFIGURED', 503));
    await assert.rejects(auth.preauth(request, env), rejected('DOCTOR_NOT_CONFIGURED', 503));
    await assert.rejects(auth.login(request, env, {}, {}), rejected('DOCTOR_NOT_CONFIGURED', 503));
    await assert.rejects(auth.require(request, env), rejected('DOCTOR_NOT_CONFIGURED', 503));
  }
  assert.equal(touched, false);
});

test('password HMAC matches an independent implementation and binds both the credential and pepper', async () => {
  const expected = createHmac('sha256', Buffer.from(PEPPER, 'base64url'))
    .update(`revir-doctor-password-v1\0${SECRET}`, 'utf8').digest('hex');
  assert.equal(await hashPassword(SECRET, PEPPER), expected);
  assert.notEqual(expected, await hashKey(SECRET));
  assert.notEqual(expected, await hashPassword('862494', PEPPER));
  assert.notEqual(expected, await hashPassword(SECRET, Buffer.alloc(32, 11).toString('base64url')));
});

test('malformed or partially configured peppers fail closed before database access', async () => {
  let touched = false;
  const auth = new DoctorAuth({ prepare() { touched = true; throw Error('must not run'); } });
  const request = new Request(`${ORIGIN}/api/doctor/session`);
  for (const pepper of ['', null, 7, 'short', 'A'.repeat(44), 'A'.repeat(42) + 'B', '+'.repeat(43)]) {
    const env = { DOCTOR_KEY_HASH: 'a'.repeat(64), DOCTOR_KEY_PEPPER: pepper };
    await assert.rejects(auth.session(request, env), rejected('DOCTOR_NOT_CONFIGURED', 503));
    await assert.rejects(auth.preauth(request, env), rejected('DOCTOR_NOT_CONFIGURED', 503));
    await assert.rejects(auth.login(request, env, {}, {}), rejected('DOCTOR_NOT_CONFIGURED', 503));
    await assert.rejects(auth.require(request, env), rejected('DOCTOR_NOT_CONFIGURED', 503));
  }
  assert.equal(touched, false);
});

test('legacy SHA256 only accepts long credentials and never enables a short PIN', async t => {
  const legacy = await fixture(t, { password: LEGACY_SECRET, pepper: null });
  assert.equal((await legacy.auth.login(legacy.request(), legacy.env, { password: LEGACY_SECRET }, legacy.initial.session)).session.authenticated, true);
  const short = await fixture(t, { pepper: null });
  await assert.rejects(short.auth.login(short.request(), short.env, { password: SECRET }, short.initial.session), rejected('LOGIN_FAILED', 401));
});

test('pre-login cookies are separate, secure and store only a token digest', async t => {
  const f = await fixture(t);
  assert.match(f.initial.cookie, /^__Host-revir_doctor=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1800; Secure$/);
  assert.equal(f.initial.session.authenticated, false);
  assert.equal(f.initial.session.expires, f.clock.value + 30 * 60_000);
  const rawToken = f.pair.split('=')[1];
  const row = await f.db.prepare('SELECT * FROM doctor_sessions').first();
  assert.equal(row.hash, await hashKey(rawToken));
  assert.notEqual(row.hash, rawToken);
  assert.equal(JSON.stringify(row).includes(SECRET), false);
  await assert.rejects(f.auth.require(f.request(), f.env), rejected('LOGIN_REQUIRED', 401));
  assert.equal(await f.auth.session(new Request(`${ORIGIN}/api/doctor/session`, { headers: { cookie: `revir_worker_local=${rawToken}` } }), f.env), null);
});

test('local development uses a separate HttpOnly cookie without Secure', async t => {
  const f = await fixture(t);
  const local = await f.auth.preauth(new Request('http://127.0.0.1:8787/api/doctor/session'), f.env);
  assert.match(local.cookie, /^revir_doctor_local=/);
  assert.match(local.cookie, /HttpOnly; SameSite=Lax; Max-Age=1800$/);
  assert.equal(local.cookie.includes('Secure'), false);
});

test('correct password rotates both tokens and consumes the previous session', async t => {
  const f = await fixture(t);
  const result = await f.auth.login(f.request(), f.env, { password: SECRET }, f.initial.session);
  assert.notEqual(result.session.hash, f.initial.session.hash);
  assert.notEqual(result.session.csrf, f.initial.session.csrf);
  assert.equal(result.session.authenticated, true);
  assert.equal(result.session.expires, f.clock.value + EIGHT_HOURS);
  assert.equal(result.session.email, f.env.DOCTOR_EMAIL);
  assert.match(result.cookie, /Max-Age=28800; Secure$/);
  assert.equal(await f.auth.session(f.request(), f.env), null);
  const request = authRequest(cookiePair(result.cookie), result.session.csrf);
  assert.deepEqual(await f.auth.require(request, f.env), result.session);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_sessions').first()).count, 1);
  assert.equal((await f.db.prepare('SELECT hash FROM sessions').all()).results.length, 0);
});

test('wrong numeric PIN and malformed input never authenticate', async t => {
  const f = await fixture(t);
  for (const password of ['862494', '86249', '8624930', 'incorrect_password_with_enough_characters', ' '.repeat(50), 7, null]) {
    await assert.rejects(f.auth.login(f.request(), f.env, { password }, f.initial.session), rejected('LOGIN_FAILED', 401));
  }
  assert.equal((await f.auth.session(f.request(), f.env)).authenticated, false);
  const limits = (await f.db.prepare('SELECT scope,attempts FROM doctor_login_limits').all()).results;
  assert.equal(limits.every(row => row.attempts === 7), true);
  assert.equal(JSON.stringify(limits).includes('192.0.2.12'), false);
});

test('login requires its current cookie, CSRF and exact origin before counting attempts', async t => {
  const f = await fixture(t);
  await assert.rejects(f.auth.login(f.request({ 'x-csrf-token': 'invalid' }), f.env, { password: SECRET }, f.initial.session), rejected('CSRF_INVALID', 403));
  await assert.rejects(f.auth.login(f.request({ origin: 'https://attacker.example' }), f.env, { password: SECRET }, f.initial.session), rejected('ORIGIN_FORBIDDEN', 403));
  await assert.rejects(f.auth.login(f.request({ cookie: '' }), f.env, { password: SECRET }, f.initial.session), rejected('LOGIN_FAILED', 401));
  await assert.rejects(f.auth.login(f.request(), f.env, { password: SECRET }, { ...f.initial.session, hash: 'forged' }), rejected('LOGIN_FAILED', 401));
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_login_limits').first()).count, 0);
});

test('preauth refresh preserves the cookie and never extends its fixed expiry', async t => {
  const f = await fixture(t);
  f.clock.value += 60_000;
  const reused = await f.auth.preauth(f.request(), f.env);
  assert.deepEqual(reused.session, f.initial.session);
  assert.equal(cookiePair(reused.cookie), f.pair);
  assert.match(reused.cookie, /Max-Age=1740;/);
  f.clock.value = f.initial.session.expires;
  assert.equal(await f.auth.session(f.request(), f.env), null);
  await assert.rejects(f.auth.login(f.request(), f.env, { password: SECRET }, f.initial.session), rejected('LOGIN_FAILED', 401));
});

test('authenticated expiry is exact, fixed and unaffected by refresh', async t => {
  const f = await fixture(t);
  const result = await f.auth.login(f.request(), f.env, { password: SECRET }, f.initial.session);
  const request = authRequest(cookiePair(result.cookie), result.session.csrf);
  f.clock.value = result.session.expires - 1;
  assert.equal((await f.auth.require(request, f.env)).authenticated, true);
  assert.equal((await f.auth.preauth(request, f.env)).session.expires, result.session.expires);
  f.clock.value++;
  await assert.rejects(f.auth.require(request, f.env), rejected('LOGIN_REQUIRED', 401));
});

test('secret rotation immediately revokes preauth and authenticated sessions', async t => {
  const f = await fixture(t);
  const second = await f.auth.preauth(new Request(`${ORIGIN}/api/doctor/session`), f.env);
  const result = await f.auth.login(f.request(), f.env, { password: SECRET }, f.initial.session);
  const rotated = { ...f.env, DOCTOR_KEY_HASH: await hashPassword('862494', PEPPER) };
  assert.equal(await f.auth.session(authRequest(cookiePair(second.cookie), second.session.csrf), rotated), null);
  await assert.rejects(f.auth.require(authRequest(cookiePair(result.cookie), result.session.csrf), rotated), rejected('LOGIN_REQUIRED', 401));
  const fresh = await f.auth.preauth(new Request(`${ORIGIN}/api/doctor/session`), rotated);
  const freshRequest = authRequest(cookiePair(fresh.cookie), fresh.session.csrf);
  await assert.rejects(f.auth.login(freshRequest, rotated, { password: SECRET }, fresh.session), rejected('LOGIN_FAILED', 401));
  assert.equal((await f.auth.login(freshRequest, rotated, { password: '862494' }, fresh.session)).session.authenticated, true);
});

test('untrusted Access or email headers cannot authenticate or select an identity', async t => {
  const f = await fixture(t);
  const request = new Request(`${ORIGIN}/api/doctor/state`, { headers: {
    'cf-access-jwt-assertion': 'anything',
    'cf-access-authenticated-user-email': f.env.DOCTOR_EMAIL,
    'x-doctor-email': f.env.DOCTOR_EMAIL,
  } });
  await assert.rejects(f.auth.require(request, f.env), rejected('LOGIN_REQUIRED', 401));
});

test('logout revokes the server session and clears the correct secure cookie', async t => {
  const f = await fixture(t);
  const result = await f.auth.login(f.request(), f.env, { password: SECRET }, f.initial.session);
  const request = authRequest(cookiePair(result.cookie), result.session.csrf);
  await assert.rejects(f.auth.logout(authRequest(cookiePair(result.cookie), 'wrong'), f.env, result.session), rejected('CSRF_INVALID', 403));
  const logout = await f.auth.logout(request, f.env, result.session);
  assert.equal(logout.cookie, '__Host-revir_doctor=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  await assert.rejects(f.auth.require(request, f.env), rejected('LOGIN_REQUIRED', 401));
});

test('concurrent login retries consume one preauth session only once', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.auth.login(f.request(), f.env, { password: SECRET }, f.initial.session)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_sessions WHERE authenticated=1').first()).count, 1);
});

test('persistent IP limit caps concurrent attempts and resets after five minutes', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 14 }, () => f.auth.login(f.request(), f.env, { password: 'wrong_but_long_enough_password_0123456789' }, f.initial.session)));
  assert.equal(results.filter(result => result.reason?.status === 401).length, 10);
  assert.equal(results.filter(result => result.reason?.status === 429).length, 4);
  await assert.rejects(new DoctorAuth(f.db, () => f.clock.value).login(f.request(), f.env, { password: SECRET }, f.initial.session), rejected('LOGIN_RATE_LIMITED', 429));
  f.clock.value += FIVE_MINUTES;
  assert.equal((await f.auth.login(f.request(), f.env, { password: SECRET }, f.initial.session)).session.authenticated, true);
});

test('persistent rate limits reject before accessing the supplied password', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) {
    await assert.rejects(f.auth.login(f.request(), f.env, { password: '862494' }, f.initial.session), rejected('LOGIN_FAILED', 401));
  }
  let read = false;
  const body = { get password() { read = true; throw new Error('verification must not run'); } };
  await assert.rejects(f.auth.login(f.request(), f.env, body, f.initial.session), rejected('LOGIN_RATE_LIMITED', 429));
  assert.equal(read, false);
});

test('global persistent limit blocks attempts spread across network addresses', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 36 }, (_, index) => f.auth.login(
    f.request({ 'cf-connecting-ip': `192.0.2.${index + 1}` }), f.env, { password: 'wrong_but_long_enough_password_0123456789' }, f.initial.session,
  )));
  assert.equal(results.filter(result => result.reason?.status === 401).length, 30);
  assert.equal(results.filter(result => result.reason?.status === 429).length, 6);
  assert.equal((await f.db.prepare("SELECT attempts FROM doctor_login_limits WHERE scope='global'").first()).attempts, 36);
});

test('cleanup independently removes expired doctor sessions and attempt counters', async t => {
  const f = await fixture(t);
  await assert.rejects(f.auth.login(f.request(), f.env, { password: 'wrong_but_long_enough_password_0123456789' }, f.initial.session));
  f.clock.value = f.initial.session.expires;
  await f.auth.cleanup();
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_sessions').first()).count, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_login_limits').first()).count, 0);
});

test('duplicate or malformed doctor cookies are rejected', async t => {
  const f = await fixture(t);
  for (const cookie of [`${f.pair}; ${f.pair}`, '__Host-revir_doctor=bad', '__Host-revir_doctor=' + 'x'.repeat(200)]) {
    assert.equal(await f.auth.session(f.request({ cookie }), f.env), null);
  }
});

test('CSRF and same-origin guards reject empty or cross-site inputs', () => {
  const csrf = 'a'.repeat(43);
  assert.doesNotThrow(() => verifyCsrf(authRequest('', csrf), csrf));
  for (const submitted of ['', csrf.slice(1), `${csrf.slice(0, -1)}b`]) {
    assert.throws(() => verifyCsrf(authRequest('', submitted), csrf), rejected('CSRF_INVALID', 403));
  }
  assert.throws(() => verifyCsrf(authRequest('', csrf), undefined), rejected('CSRF_INVALID', 403));
  assert.doesNotThrow(() => requireSameOrigin(authRequest('', csrf)));
  for (const origin of ['', 'null', 'https://attacker.example', 'http://revir-test.workers.dev', `${ORIGIN}/`]) {
    assert.throws(() => requireSameOrigin(authRequest('', csrf, { origin })), rejected('ORIGIN_FORBIDDEN', 403));
  }
  assert.throws(() => requireSameOrigin(authRequest('', csrf, { 'sec-fetch-site': 'cross-site' })), rejected('ORIGIN_FORBIDDEN', 403));
});
