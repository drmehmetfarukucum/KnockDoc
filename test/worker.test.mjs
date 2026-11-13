import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import workerDefault, { createWorker } from '../src/worker.mjs';
import { DoctorAuth, hashKey, hashPassword } from '../src/auth.mjs';
import { RETENTION_MS } from '../src/rules.mjs';
import { createD1Fixture, DAY } from './d1-fixture.mjs';

const ORIGIN = 'https://revir.example.test';
const TEST_KEY = 'TestOnly_NotAProductionKey_0123456789abcdef';
const TEST_PIN = '862493'; // Synthetic credential for HTTP verification only.
const TEST_PEPPER = Buffer.alloc(32, 17).toString('base64url');
const CONFIG = { DOCTOR_EMAIL: 'hekim@ornek-kurum.example' };
const allowed = { limit: async () => ({ success: true }) };

function request(path, { method = 'GET', cookie, csrf, doctor = false, body, headers = {} } = {}) {
  const all = new Headers(headers);
  if (cookie) all.set('cookie', cookie);
  if (csrf) all.set('x-csrf-token', csrf);
  if (doctor?.cookie) all.set('cookie', doctor.cookie);
  if (doctor?.csrfToken && !csrf) all.set('x-csrf-token', doctor.csrfToken);
  if (method === 'POST') {
    if (!all.has('origin')) all.set('origin', ORIGIN);
    if (!all.has('content-type')) all.set('content-type', 'application/json');
  }
  return new Request(ORIGIN + path, { method, headers: all, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}

async function setup(t, { push } = {}) {
  const fixture = await createD1Fixture();
  t.after(() => fixture.dispose());
  const assets = { fetch: async req => new Response(new URL(req.url).pathname === '/index.html' ? '<!doctype html><h1>Revir</h1>' : 'test asset') };
  const env = { ...CONFIG, DOCTOR_KEY_HASH: await hashPassword(TEST_KEY, TEST_PEPPER), DOCTOR_KEY_PEPPER: TEST_PEPPER,
    DB: fixture.db, ASSETS: assets, PUBLIC_LIMIT: allowed, SESSION_LIMIT: allowed, SUBMIT_LIMIT: allowed, LOGIN_LIMIT: allowed, LOGIN_GLOBAL_LIMIT: allowed, PUSH_LIMIT: allowed };
  const worker = createWorker({ makeAuth: () => new DoctorAuth(fixture.db, () => fixture.clock.value), makeStore: () => fixture.store, ...(push ? { makePush: () => push } : {}) });
  const fetch = (path, options) => worker.fetch(request(path, options), env);
  async function employee() {
    const response = await fetch('/api/public');
    assert.equal(response.status, 200);
    return { state: await response.json(), cookie: response.headers.get('set-cookie').split(';')[0], response };
  }
  async function doctor() {
    const pre = await fetch('/api/doctor/session');
    assert.equal(pre.status, 200);
    const preState = await pre.json();
    assert.equal(preState.authenticated, false);
    const preCookie = pre.headers.get('set-cookie').split(';')[0];
    const response = await fetch('/api/doctor/login', { method: 'POST', cookie: preCookie,
      csrf: preState.csrfToken, body: { password: TEST_KEY } });
    assert.equal(response.status, 200, await response.clone().text());
    const state = await response.json();
    assert.equal(state.authenticated, true);
    assert.notEqual(state.csrfToken, preState.csrfToken);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, preCookie);
    return { ...state, cookie, preCookie };
  }
  async function submit(employee, extras = {}) {
    const response = await fetch('/api/requests', { method: 'POST', cookie: employee.cookie, csrf: employee.state.csrfToken,
      body: { operationId: crypto.randomUUID(), formDate: employee.state.formDate, ...extras } });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).request;
  }
  return { ...fixture, env, worker, fetch, employee, doctor, submit };
}

test('production default denies every private doctor API without a valid server session', async t => {
  const f = await setup(t);
  for (const path of ['/api/doctor/state', '/api/doctor/settings', '/api/doctor/logout', '/api/doctor/push', '/api/doctor/push/subscribe', '/api/doctor/push/unsubscribe', '/api/doctor/push/test',
    '/api/doctor/requests/00000000-0000-0000-0000-000000000000/answer',
    '/api/doctor/requests/00000000-0000-0000-0000-000000000000/complete',
    '/api/doctor/requests/00000000-0000-0000-0000-000000000000/reopen']) {
    const post = !['/api/doctor/state', '/api/doctor/push'].includes(path);
    const response = await workerDefault.fetch(request(path, post ? { method: 'POST', body: {} } : {}), f.env);
    assert.equal(response.status, 401, path);
    assert.doesNotMatch(await response.text(), /ornek-kurum\.example|DOCTOR_KEY_HASH/);
  }
  assert.equal((await workerDefault.fetch(request('/api/doctor/session'), { ...f.env, DOCTOR_KEY_HASH: '' })).status, 503);
  assert.equal((await workerDefault.fetch(request('/api/doctor/session'), { ...f.env, DOCTOR_KEY_PEPPER: '' })).status, 503);
});

test('public cookie is secure and opening the page creates no request', async t => {
  const f = await setup(t);
  const employee = await f.employee();
  assert.match(employee.response.headers.get('set-cookie'), /^__Host-revir_worker=/);
  for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']) assert.ok(employee.response.headers.get('set-cookie').includes(flag));
  assert.equal(employee.response.headers.get('cache-control'), 'no-store');
  assert.equal(employee.state.requests.length, 0);
  assert.equal((await f.store.doctorState()).requests.length, 0);
  assert.equal('owner' in employee.state, false);
});

test('HTTP employee to password-authenticated doctor reply and undo round trip preserves privacy', async t => {
  const f = await setup(t);
  const a = await f.employee(), b = await f.employee(), doctor = await f.doctor();
  const created = await f.submit(a, { phone: '000 000 0000', fullName: 'Örnek Çalışan', note: 'Örnek talep' });
  await f.submit(b);
  assert.equal(doctor.email, CONFIG.DOCTOR_EMAIL);
  assert.doesNotMatch(JSON.stringify(doctor), new RegExp(TEST_KEY));
  const change = async (action, body) => {
    const res = await f.fetch(`/api/doctor/requests/${created.id}/${action}`, { method: 'POST', doctor, csrf: doctor.csrfToken, body });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).request;
  };
  const answered = await change('answer', { expectedVersion: created.version, text: 'Birazdan görüşelim.' });
  const done = await change('complete', { expectedVersion: answered.version });
  const reopened = await change('reopen', { expectedVersion: done.version });
  assert.equal(reopened.status, 'answered');
  assert.equal(reopened.reply, answered.reply);
  const aState = await (await f.fetch('/api/public', { cookie: a.cookie })).json();
  const bState = await (await f.fetch('/api/public', { cookie: b.cookie })).json();
  assert.equal(aState.requests[0].reply, answered.reply);
  assert.doesNotMatch(JSON.stringify(bState), /Örnek Çalışan|Örnek talep|Birazdan görüşelim/);
  assert.equal((await (await f.fetch('/api/doctor/state', { doctor })).json()).requests.length, 2);
});

test('HTTP distinct requests remain independent while retries after completion or midnight keep the original and send no extra push', async t => {
  let sends = 0;
  const f = await setup(t, { push: { sendAll: async () => { sends++; } } });
  const employee = await f.employee(), other = await f.employee(), doctor = await f.doctor();
  const bodies = Array.from({ length: 3 }, (_, index) => ({
    operationId: crypto.randomUUID(), formDate: employee.state.formDate, note: `Ayrı örnek talep ${index}`,
  }));
  const submit = body => f.fetch('/api/requests', { method: 'POST', cookie: employee.cookie, csrf: employee.state.csrfToken, body });
  const responses = await Promise.all(bodies.map(submit));
  assert.ok(responses.every(response => response.status === 201));
  const requests = await Promise.all(responses.map(async response => (await response.json()).request));
  assert.equal(new Set(requests.map(item => item.id)).size, bodies.length);
  assert.deepEqual(requests.map(item => item.note), bodies.map(item => item.note));
  assert.equal(sends, bodies.length);
  const complete = await f.fetch(`/api/doctor/requests/${requests[0].id}/complete`, {
    method: 'POST', doctor, body: { expectedVersion: requests[0].version },
  });
  assert.equal(complete.status, 200);
  const done = (await complete.json()).request;
  f.clock.value += DAY;
  for (const [index, body] of bodies.entries()) {
    const response = await submit({ ...body, note: 'Tekrar denemede değiştirme' });
    assert.equal(response.status, 200);
    const retry = await response.json();
    assert.equal(retry.created, false);
    assert.equal(retry.request.id, requests[index].id);
    assert.equal(retry.request.note, body.note);
    assert.equal(retry.request.status, index === 0 ? 'done' : 'new');
  }
  assert.equal(sends, bodies.length);
  const fourth = await f.submit({ ...employee, state: { ...employee.state, formDate: '2026-10-06' } });
  assert.ok(!requests.some(item => item.id === fourth.id));
  assert.equal(sends, bodies.length + 1);
  const freshDoctor = await f.doctor();
  const undo = await f.fetch(`/api/doctor/requests/${requests[0].id}/reopen`, {
    method: 'POST', doctor: freshDoctor, body: { expectedVersion: done.version },
  });
  assert.equal(undo.status, 200);
  assert.equal((await undo.json()).request.status, 'new');
  const own = await (await f.fetch('/api/public', { cookie: employee.cookie })).json();
  assert.equal(own.requests.length, 4);
  assert.ok(own.requests.every(item => item.status === 'new'));
  assert.equal((await (await f.fetch('/api/public', { cookie: other.cookie })).json()).requests.length, 0);
});

test('forged identity headers and an employee cookie cannot read doctor data', async t => {
  const f = await setup(t), employee = await f.employee();
  for (const path of ['/api/doctor/state', '/api/doctor/settings']) {
    const response = await f.fetch(path, { cookie: employee.cookie,
      headers: { 'cf-access-jwt-assertion': 'forged', 'cf-access-authenticated-user-email': CONFIG.DOCTOR_EMAIL },
      ...(path.endsWith('settings') ? { method: 'POST', body: {} } : {}) });
    assert.equal(response.status, 401);
  }
  const shell = await f.fetch('/doktor');
  assert.equal(shell.status, 200);
  assert.doesNotMatch(await shell.text(), /ornek-kurum\.example|TestOnly|DOCTOR_KEY_HASH/);
});

test('missing or foreign CSRF and cross-site origin cannot submit or change settings', async t => {
  const f = await setup(t), employee = await f.employee(), doctor = await f.doctor();
  const body = { operationId: crypto.randomUUID(), formDate: employee.state.formDate };
  const normal = { method: 'POST', cookie: employee.cookie, csrf: employee.state.csrfToken, body };
  for (const options of [{ ...normal, csrf: undefined }, { ...normal, csrf: 'x'.repeat(43) },
    { ...normal, headers: { origin: 'https://other.example.test' } }, { ...normal, headers: { 'sec-fetch-site': 'cross-site' } }]) {
    assert.equal((await f.fetch('/api/requests', options)).status, 403);
  }
  const before = await f.store.settings();
  assert.equal((await f.fetch('/api/doctor/settings', { method: 'POST', doctor, csrf: employee.state.csrfToken,
    body: { expectedVersion: before.version, workPhone: '000' } })).status, 403);
  assert.equal((await f.store.settings()).version, before.version);
  assert.equal((await f.store.doctorState()).requests.length, 0);
  assert.notEqual(doctor.csrfToken, employee.state.csrfToken);
});

test('body limits, invalid JSON and wrong content type reject before record insertion', async t => {
  const f = await setup(t), employee = await f.employee();
  const normal = { method: 'POST', cookie: employee.cookie, csrf: employee.state.csrfToken };
  for (const [options, status] of [[{ ...normal, body: '{' }, 400], [{ ...normal, body: [] }, 400],
    [{ ...normal, body: 'x'.repeat(16385) }, 413], [{ ...normal, body: {}, headers: { 'content-type': 'text/plain' } }, 415]]) {
    assert.equal((await f.fetch('/api/requests', options)).status, status);
  }
  assert.equal((await f.store.doctorState()).requests.length, 0);
});

test('every script referenced by the shipped HTML is reachable through the public Worker asset routes', async t => {
  const f = await setup(t);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src="(\/[^\"]+\.js)"/g)].map(match => match[1]);
  assert.ok(!scripts.includes('/doctor-sound.js'));
  assert.ok(scripts.includes('/app.js'));
  f.env.ASSETS = { fetch: async req => {
    const path = new URL(req.url).pathname;
    assert.ok(scripts.includes(path));
    return new Response(await readFile(new URL('../public' + path, import.meta.url), 'utf8'), {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
    });
  } };
  for (const path of scripts) {
    const response = await f.fetch(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.equal(await response.text(), await readFile(new URL('../public' + path, import.meta.url), 'utf8'));
    const head = await f.fetch(path, { method: 'HEAD' });
    assert.equal(head.status, 200, path);
    assert.equal(head.body, null);
  }
});

test('private source files and unsupported addresses never reach the assets binding', async t => {
  const f = await setup(t);
  let reads = 0;
  f.env.ASSETS = { fetch: async () => { reads++; return new Response('asset'); } };
  for (const path of ['/schema.sql', '/src/worker.mjs', '/index.html', '/wrangler.jsonc', '/.dev.vars']) {
    assert.equal((await f.fetch(path)).status, 404);
  }
  assert.equal((await f.fetch('/?test=1')).status, 400);
  assert.equal(reads, 0);
  assert.equal((await f.fetch('/')).status, 200);
  assert.equal((await f.fetch('/styles.css')).status, 200);
  assert.equal((await f.fetch('/doktor')).status, 200);
  assert.equal(reads, 3);
  assert.equal((await f.fetch('/', { method: 'HEAD' })).body, null);
});

test('rate gates reject session creation and submission without storing the attempt', async t => {
  const f = await setup(t);
  f.env.SESSION_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await f.fetch('/api/public')).status, 429);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM sessions').first()).count, 0);
  f.env.SESSION_LIMIT = allowed;
  const employee = await f.employee();
  f.env.SUBMIT_LIMIT = { limit: async () => ({ success: false }) };
  const response = await f.fetch('/api/requests', { method: 'POST', cookie: employee.cookie, csrf: employee.state.csrfToken,
    body: { operationId: crypto.randomUUID(), formDate: employee.state.formDate } });
  assert.equal(response.status, 429);
  assert.equal((await f.store.doctorState()).requests.length, 0);
});

test('Cloudflare scheduled cleanup deletes expired requests and session metadata without page visits', async t => {
  const f = await setup(t), employee = await f.employee();
  await f.submit(employee);
  f.clock.value += RETENTION_MS;
  await f.worker.scheduled({}, f.env);
  for (const table of ['requests', 'request_operations', 'sessions']) {
    assert.equal((await f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0);
  }
});

test('doctor logout revokes the server session and clears its cookie', async t => {
  const f = await setup(t), doctor = await f.doctor();
  const response = await f.fetch('/api/doctor/logout', { method: 'POST', doctor, csrf: doctor.csrfToken, body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false });
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.fetch('/api/doctor/state', { doctor })).status, 401);
});

test('doctor logout revokes authentication even when phone subscription cleanup fails', async t => {
  let cleanupCalls = 0;
  const f = await setup(t, { push: { removeSession: async () => { cleanupCalls++; throw new Error('private endpoint cleanup failure'); } } });
  const doctor = await f.doctor();
  const response = await f.fetch('/api/doctor/logout', { method: 'POST', doctor, body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false });
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(cleanupCalls, 1);
  assert.equal((await f.fetch('/api/doctor/state', { doctor })).status, 401, 'the old authenticated cookie is revoked');
  assert.equal((await f.fetch('/api/doctor/feedback', { doctor })).status, 401);
});


test('HTTP login rejects wrong credentials without leaking or rotating the pre-login session', async t => {
  const f = await setup(t);
  const pre = await f.fetch('/api/doctor/session');
  const state = await pre.json(), cookie = pre.headers.get('set-cookie').split(';')[0];
  assert.equal('email' in state, false);
  for (const password of [TEST_PIN, 'WrongKey_0123456789abcdefghijklmnopqrstuvwxyz']) {
    const response = await f.fetch('/api/doctor/login', { method: 'POST', cookie, csrf: state.csrfToken, body: { password } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.doesNotMatch(await response.text(), new RegExp(password));
  }
  const same = await (await f.fetch('/api/doctor/session', { cookie })).json();
  assert.equal(same.csrfToken, state.csrfToken);
  assert.equal(same.authenticated, false);
});

test('HTTP numeric PIN login rotates the session while credential change revokes the former key and sessions', async t => {
  const f = await setup(t), former = await f.doctor();
  f.env.DOCTOR_KEY_HASH = await hashPassword(TEST_PIN, TEST_PEPPER);
  assert.equal((await f.fetch('/api/doctor/state', { doctor: former })).status, 401);
  const pre = await f.fetch('/api/doctor/session');
  const state = await pre.json(), cookie = pre.headers.get('set-cookie').split(';')[0];
  const options = { method: 'POST', cookie, csrf: state.csrfToken };
  assert.equal((await f.fetch('/api/doctor/login', { ...options, body: { password: TEST_KEY } })).status, 401);
  const login = await f.fetch('/api/doctor/login', { ...options, body: { password: TEST_PIN } });
  assert.equal(login.status, 200);
  const authenticated = await login.json(), nextCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(authenticated.authenticated, true);
  assert.notEqual(authenticated.csrfToken, state.csrfToken);
  assert.notEqual(nextCookie, cookie);
  assert.doesNotMatch(JSON.stringify(authenticated), new RegExp(`${TEST_PIN}|${TEST_PEPPER}|DOCTOR_KEY`));
  assert.equal((await f.fetch('/api/doctor/state', { cookie })).status, 401);
  assert.equal((await f.fetch('/api/doctor/state', { cookie: nextCookie })).status, 200);
});

test('HTTP login requires pre-login CSRF and throttles before password verification', async t => {
  const f = await setup(t);
  const pre = await f.fetch('/api/doctor/session');
  const state = await pre.json(), cookie = pre.headers.get('set-cookie').split(';')[0];
  const options = { method: 'POST', cookie, csrf: state.csrfToken, body: { password: TEST_KEY } };
  assert.equal((await f.fetch('/api/doctor/login', { ...options, csrf: 'x'.repeat(43) })).status, 403);
  assert.equal((await f.fetch('/api/doctor/login', { ...options, headers: { origin: 'https://evil.test' } })).status, 403);
  f.env.LOGIN_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await f.fetch('/api/doctor/login', options)).status, 429);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM doctor_login_limits').first()).count, 0);
  f.env.LOGIN_LIMIT = allowed;
  f.env.LOGIN_GLOBAL_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await f.fetch('/api/doctor/login', options)).status, 429);
});

test('doctor login bootstrap reuses CSRF and eight-hour session expires without renewal', async t => {
  const f = await setup(t), doctor = await f.doctor();
  let response = await f.fetch('/api/doctor/session', { doctor });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).csrfToken, doctor.csrfToken);
  assert.equal((await f.fetch('/api/doctor/state', { cookie: doctor.preCookie })).status, 401);
  f.clock.value += 8 * 60 * 60 * 1000 - 1;
  assert.equal((await f.fetch('/api/doctor/state', { doctor })).status, 200);
  f.clock.value++;
  assert.equal((await f.fetch('/api/doctor/state', { doctor })).status, 401);
  response = await f.fetch('/api/doctor/session', { doctor });
  assert.equal((await response.json()).authenticated, false);
  assert.ok(response.headers.get('set-cookie'));
});

test('push device routes require physician CSRF, use server session ownership, and throttle tests', async t => {
  const calls = [];
  const push = {
    subscribe: async (...args) => calls.push(['subscribe', ...args]),
    unsubscribe: async (...args) => calls.push(['unsubscribe', ...args]),
    test: async (...args) => { calls.push(['test', ...args]); return { accepted: 1 }; },
    removeSession: async (...args) => calls.push(['logout', ...args]),
  };
  const f = await setup(t, { push }), doctor = await f.doctor();
  const body = { endpoint: 'https://web.push.apple.com/test-only-endpoint' };
  const options = { method: 'POST', doctor, body };
  assert.equal((await f.fetch('/api/doctor/push/subscribe', { ...options, csrf: 'foreign' })).status, 403);
  assert.equal(calls.length, 0);
  for (const action of ['subscribe', 'test', 'unsubscribe']) {
    const response = await f.fetch(`/api/doctor/push/${action}`, options);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /endpoint|credential|VAPID|session_hash/);
  }
  const sessionHash = await hashKey(doctor.cookie.split('=')[1]);
  assert.equal(calls[0][3], sessionHash);
  assert.equal(calls[1][3], sessionHash);
  f.env.PUSH_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await f.fetch('/api/doctor/push/test', options)).status, 429);
  assert.equal(calls.length, 3);
  await f.fetch('/api/doctor/logout', { method: 'POST', doctor, body: {} });
  assert.deepEqual(calls[3], ['logout', sessionHash, f.env]);
});

test('new requests trigger one push; repeated operation and provider failure preserve saved request', async t => {
  let sends = 0;
  const push = { sendAll: async () => { sends++; throw new Error('provider unavailable'); } };
  const f = await setup(t, { push }), employee = await f.employee();
  const body = { operationId: crypto.randomUUID(), formDate: employee.state.formDate };
  const options = { method: 'POST', cookie: employee.cookie, csrf: employee.state.csrfToken, body };
  const first = await f.fetch('/api/requests', options);
  assert.equal(first.status, 201);
  assert.equal(sends, 1);
  const firstState = await first.json();
  const repeat = await f.fetch('/api/requests', options);
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).request.id, firstState.request.id);
  assert.equal(sends, 1);
  assert.equal((await f.store.doctorState()).requests.length, 1);
});

test('provider rejection is reported as test failure, never as delivered notification', async t => {
  const push = { test: async () => ({ accepted: 0 }) };
  const f = await setup(t, { push }), doctor = await f.doctor();
  const response = await f.fetch('/api/doctor/push/test', { method: 'POST', doctor, body: { endpoint: 'https://web.push.apple.com/test-only' } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PUSH_NOT_ACCEPTED');
});
