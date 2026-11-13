import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createD1Fixture, DAY } from './d1-fixture.mjs';
import { AppError, RETENTION_MS, localTime } from '../src/rules.mjs';
import { createWorker } from '../src/worker.mjs';

const ORIGIN = 'https://revir.example.test';
const allowed = { limit: async () => ({ success: true }) };
const note = (extras = {}) => ({ operationId: crypto.randomUUID(), text: 'Sentetik kısa not', ...extras });
const feedback = (extras = {}) => ({ operationId: crypto.randomUUID(), text: 'Sentetik uygulama görüşü', category: 'suggestion', ...extras });

async function setup(t) {
  const f = await createD1Fixture();
  t.after(() => f.dispose());
  const employee = await f.createWorker();
  const request = (await f.store.createRequest(employee.session, {
    operationId: crypto.randomUUID(), formDate: localTime(f.clock.value).date,
  })).request;
  return { ...f, employee, request };
}
async function rejects(call, status, code) {
  await assert.rejects(call, error => error instanceof AppError && error.status === status && (!code || error.code === code));
}
function http(f, { pushError } = {}) {
  const pushes = [];
  const authCalls = [];
  const worker = createWorker({ makeStore: () => f.store, makePush: () => ({ sendAll: async (env, options) => { pushes.push(options); if (pushError) throw pushError; } }),
    makeAuth: () => ({ require: async request => {
      authCalls.push(request.url);
      if (request.headers.get('cookie') !== 'doctor=synthetic') throw new AppError(401, 'UNAUTHORIZED', 'Giriş yapın.');
      return { hash: 'synthetic-doctor', csrf: 'synthetic-doctor-csrf' };
    } }),
  });
  const env = { DB: f.db, PUBLIC_LIMIT: allowed, SESSION_LIMIT: allowed, SUBMIT_LIMIT: allowed };
  const fetch = (path, { method = 'POST', body, headers = {}, employee = f.employee, noCsrf = false, doctor = false } = {}) => {
    const h = new Headers({ origin: ORIGIN, 'content-type': 'application/json', ...headers });
    if (doctor) h.set('cookie', 'doctor=synthetic');
    else if (employee) h.set('cookie', `__Host-revir_worker=${employee.token}`);
    if (!noCsrf) h.set('x-csrf-token', doctor ? 'synthetic-doctor-csrf' : employee?.session.csrf || '');
    return worker.fetch(new Request(ORIGIN + path, { method, headers: h,
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }), env);
  };
  return { fetch, pushes, authCalls, env };
}

test('short notes and optional contacts are saved on the same request and survive every mutation response', async t => {
  const f = await setup(t);
  const beforeSession = await f.store.session(f.employee.token);
  f.clock.value += 14 * 60 * 60_000;
  assert.equal((await f.store.publicState(f.employee.session)).availability.accepting, false);
  const saved = await f.store.addRequestMessage(f.employee.session, f.request.id, note({ text: '  Bekliyorum.  ', fullName: 'Sentetik Kişi', phone: '0500 000 0000' }));
  assert.equal(saved.created, true);
  assert.equal(saved.request.messageVersion, 1);
  assert.equal(saved.request.version, f.request.version + 1);
  assert.equal(saved.request.latestMessageAt, new Date(f.clock.value).toISOString());
  assert.equal(saved.request.fullName, 'Sentetik Kişi');
  assert.equal(saved.request.phone, '0500 000 0000');
  assert.equal(saved.request.messages[0].text, 'Bekliyorum.');
  assert.deepEqual(Object.keys(saved.request.messages[0]).sort(), ['createdAt', 'fullName', 'id', 'phone', 'text']);
  assert.equal(saved.request.expiresAt, f.request.expiresAt);
  assert.equal((await f.store.session(f.employee.token)).expires, beforeSession.expires);
  for (const state of [await f.store.publicState(f.employee.session), await f.store.doctorState()]) assert.deepEqual(state.requests[0], saved.request);
  const answered = (await f.store.answer(f.request.id, { expectedVersion: saved.request.version, text: 'Geliyorum.' })).request;
  const waiting = (await f.store.updatePresence(f.employee.session, f.request.id, { expectedVersion: answered.version, expectedReplyVersion: answered.replyVersion, presence: 'waiting' })).request;
  const done = (await f.store.complete(f.request.id, { expectedVersion: waiting.version })).request;
  const reopened = (await f.store.reopen(f.request.id, { expectedVersion: done.version })).request;
  for (const request of [answered, waiting, done, reopened]) assert.deepEqual(request.messages, saved.request.messages);
  const retryRequest = (await f.store.createRequest(f.employee.session, {
    operationId: (await f.db.prepare('SELECT operation_id FROM request_operations WHERE request_id=?').bind(f.request.id).first()).operation_id,
  })).request;
  assert.deepEqual(retryRequest.messages, saved.request.messages);
});

test('contact-only additions are allowed and blank contacts preserve the last supplied contact', async t => {
  const f = await setup(t);
  const first = await f.store.addRequestMessage(f.employee.session, f.request.id, note({ text: '', fullName: 'Sentetik İsim', phone: '+90 549 000 0000' }));
  const second = await f.store.addRequestMessage(f.employee.session, f.request.id, note({ text: 'İkinci not.', fullName: '  ', phone: '' }));
  assert.equal(second.request.fullName, first.request.fullName);
  assert.equal(second.request.phone, first.request.phone);
  assert.equal(second.request.messages[1].fullName, '');
  assert.equal(second.request.messages[1].phone, '');
  assert.equal(second.request.note, f.request.note);
});

test('same-operation simultaneous notes and lost-response retries append exactly once even after completion', async t => {
  const f = await setup(t);
  const body = note();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.store.addRequestMessage(f.employee.session, f.request.id, body)));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.ok(results.every(result => result.request.messages.length === 1));
  const saved = (await f.store.publicState(f.employee.session)).requests[0];
  assert.equal(saved.messageVersion, 1);
  const done = (await f.store.complete(saved.id, { expectedVersion: saved.version })).request;
  const retry = await f.store.addRequestMessage(f.employee.session, saved.id, { ...body, text: null });
  assert.equal(retry.created, false);
  assert.deepEqual(retry.request, done);
  await rejects(f.store.addRequestMessage(f.employee.session, saved.id, note()), 409, 'MESSAGE_UNAVAILABLE');
});

test('two concurrent additions retain both messages and a completion race cannot append after completion', async t => {
  const f = await setup(t);
  const messages = await Promise.all([f.store.addRequestMessage(f.employee.session, f.request.id, note({ text: 'Birinci not.' })),
    f.store.addRequestMessage(f.employee.session, f.request.id, note({ text: 'İkinci not.' }))]);
  assert.ok(messages.every(result => result.created));
  const current = (await f.store.publicState(f.employee.session)).requests[0];
  assert.equal(current.messages.length, 2);
  assert.equal(current.messageVersion, 2);
  const race = await Promise.allSettled([f.store.addRequestMessage(f.employee.session, current.id, note({ text: 'Son not.' })),
    f.store.complete(current.id, { expectedVersion: current.version })]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  const final = (await f.store.publicState(f.employee.session)).requests[0];
  if (final.status === 'done') assert.equal(final.messages.length, 2);
  else assert.equal(final.messages.length, 3);
});

test('short notes enforce ownership, live session, active request, input bounds and per-request cap', async t => {
  const f = await setup(t);
  const other = await f.createWorker();
  await rejects(f.store.addRequestMessage(other.session, f.request.id, note()), 404);
  await rejects(f.store.addRequestMessage(f.employee.session, crypto.randomUUID(), note()), 404);
  for (const invalid of [note({ text: ' ' }), note({ text: 'x'.repeat(301) }), note({ text: '\u0001' }),
    note({ fullName: 'x'.repeat(81) }), note({ phone: 'not-a-phone' }), note({ operationId: 'invalid' })]) {
    await rejects(f.store.addRequestMessage(f.employee.session, f.request.id, invalid), 400);
  }
  for (let i = 0; i < 20; i++) await f.store.addRequestMessage(f.employee.session, f.request.id, note({ text: `Not ${i}` }));
  await rejects(f.store.addRequestMessage(f.employee.session, f.request.id, note()), 429, 'MESSAGE_LIMIT');
  assert.equal((await f.store.publicState(f.employee.session)).requests[0].messageVersion, 20);
  f.clock.value += RETENTION_MS;
  await rejects(f.store.addRequestMessage(f.employee.session, f.request.id, note()), 401, 'SESSION_EXPIRED');
});

test('feedback is separate, idempotent, available after hours and capped atomically without allocating visitor numbers', async t => {
  const f = await setup(t);
  const fresh = await f.createWorker();
  f.clock.value += 14 * 60 * 60_000;
  const beforeSession = await f.store.session(fresh.token);
  const counters = (await f.db.prepare('SELECT * FROM daily_visitor_counters').all()).results;
  const body = feedback();
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => f.store.addFeedback(fresh.session, body)));
  assert.equal(duplicates.filter(result => result.created).length, 1);
  const additions = await Promise.allSettled(Array.from({ length: 7 }, () => f.store.addFeedback(fresh.session, feedback({ category: 'bug' }))));
  assert.equal(additions.filter(result => result.status === 'fulfilled').length, 4);
  assert.ok(additions.filter(result => result.status === 'rejected').every(result => result.reason.status === 429));
  assert.deepEqual(await f.store.addFeedback(fresh.session, { ...body, text: null }), { ok: true, created: false });
  assert.deepEqual((await f.store.publicState(fresh.session)).requests, []);
  assert.deepEqual((await f.db.prepare('SELECT * FROM daily_visitor_counters').all()).results, counters);
  assert.equal((await f.store.session(fresh.token)).expires, beforeSession.expires);
  const saved = await f.store.feedback();
  assert.equal(saved.feedback.length, 5);
  assert.deepEqual(Object.keys(saved.feedback[0]).sort(), ['category', 'createdAt', 'id', 'text']);
});

test('feedback validates inputs and expires independently; request notes cascade with original requests', async t => {
  const f = await setup(t);
  for (const invalid of [feedback({ text: '' }), feedback({ text: 'x'.repeat(501) }), feedback({ category: 'diagnosis' }), feedback({ text: '\u0001' })]) {
    await rejects(f.store.addFeedback(f.employee.session, invalid), 400);
  }
  await f.store.addFeedback(f.employee.session, feedback());
  await f.store.addRequestMessage(f.employee.session, f.request.id, note());
  f.clock.value += DAY;
  await f.store.createRequest(f.employee.session, { operationId: crypto.randomUUID(), formDate: localTime(f.clock.value).date });
  f.clock.value += RETENTION_MS - DAY;
  assert.equal((await f.store.feedback()).feedback.length, 0);
  await rejects(f.store.addRequestMessage(f.employee.session, f.request.id, note()), 404);
  await f.store.cleanup();
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM request_messages').first()).count, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM app_feedback').first()).count, 0);
});

test('note endpoint pushes only a fresh anonymous coded event; retry, bad ownership and CSRF do not push', async t => {
  const f = await setup(t);
  const h = http(f);
  const path = `/api/requests/${f.request.id}/messages`;
  const body = note({ text: 'Özel not metni', fullName: 'Sentetik İsim', phone: '0500 000 0000' });
  assert.equal((await h.fetch(path, { body, noCsrf: true })).status, 403);
  assert.equal((await h.fetch(path, { body, headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await h.fetch(path, { body, employee: await f.createWorker() })).status, 404);
  const response = await h.fetch(path, { body });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await h.fetch(path, { body })).status, 200);
  assert.deepEqual(h.pushes, [{ event: { type: 'message', code: f.request.visitorCode, day: f.request.visitorDay } }]);
  const wire = JSON.stringify(h.pushes);
  for (const privateValue of [body.text, body.fullName, body.phone]) assert.equal(wire.includes(privateValue), false);
  h.env.SUBMIT_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await h.fetch(path, { body: note() })).status, 429);
  assert.equal(h.pushes.length, 1);
});

test('feedback endpoint pushes a generic event once and requires employee CSRF; private read requires physician authentication', async t => {
  const f = await setup(t);
  const h = http(f);
  const body = feedback({ category: 'bug', text: 'Özel uygulama görüşü', fullName: 'Sentetik İsim', phone: '0500 000 0000' });
  assert.equal((await h.fetch('/api/feedback', { body, employee: null })).status, 401);
  assert.equal((await h.fetch('/api/feedback', { body, noCsrf: true })).status, 403);
  assert.equal((await h.fetch('/api/feedback', { body, headers: { origin: 'https://other.example' } })).status, 403);
  const fresh = await h.fetch('/api/feedback', { body });
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), { ok: true, created: true });
  const retried = await h.fetch('/api/feedback', { body });
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { ok: true, created: false });
  assert.deepEqual(h.pushes, [{ event: { type: 'feedback' } }]);
  for (const privateValue of [body.text, body.category, body.fullName, body.phone, f.request.visitorCode, f.request.visitorDay]) assert.equal(JSON.stringify(h.pushes).includes(privateValue), false);
  assert.equal((await h.fetch('/api/doctor/feedback', { method: 'GET', employee: null })).status, 401);
  const response = await h.fetch('/api/doctor/feedback', { method: 'GET', doctor: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).feedback[0].text, body.text);
  assert.equal(h.authCalls.length, 2);
});

test('feedback validation, submission throttling and per-session cap never notify rejected submissions', async t => {
  const f = await setup(t);
  const h = http(f);
  for (const body of [feedback({ text: '' }), feedback({ category: 'diagnosis' })]) assert.equal((await h.fetch('/api/feedback', { body })).status, 400);
  assert.deepEqual(h.pushes, []);
  const body = feedback();
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => h.fetch('/api/feedback', { body })));
  assert.ok(duplicates.every(response => response.status === 200));
  assert.equal(h.pushes.length, 1);
  for (let index = 0; index < 4; index++) assert.equal((await h.fetch('/api/feedback', { body: feedback() })).status, 200);
  assert.equal(h.pushes.length, 5);
  assert.equal((await h.fetch('/api/feedback', { body: feedback() })).status, 429);
  assert.equal(h.pushes.length, 5);
  h.env.SUBMIT_LIMIT = { limit: async () => ({ success: false }) };
  assert.equal((await h.fetch('/api/feedback', { body: feedback() })).status, 429);
  assert.equal(h.pushes.length, 5);
});

test('a phone push failure preserves saved feedback and an idempotent retry does not send another notification', async t => {
  const f = await setup(t);
  const h = http(f, { pushError: new Error('provider unavailable') });
  const body = feedback();
  const response = await h.fetch('/api/feedback', { body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, created: true });
  assert.equal((await f.store.feedback()).feedback[0].text, body.text);
  const retry = await h.fetch('/api/feedback', { body });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { ok: true, created: false });
  assert.deepEqual(h.pushes, [{ event: { type: 'feedback' } }]);
  assert.equal((await f.store.feedback()).feedback.length, 1);
});

test('migration 0005 adds empty note history without altering existing request data or retention', async t => {
  const f = await setup(t);
  await f.db.exec('DROP TABLE request_messages; DROP TABLE app_feedback; ALTER TABLE requests DROP COLUMN message_version; ALTER TABLE requests DROP COLUMN latest_message_at;');
  const before = await f.db.prepare('SELECT * FROM requests WHERE id=?').bind(f.request.id).first();
  const migration = await readFile(new URL('../migrations/0005_request_notes_feedback.sql', import.meta.url), 'utf8');
  await f.db.exec(migration.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean).map(sql => sql.replaceAll('\n', ' ')).join('\n'));
  const after = await f.db.prepare('SELECT * FROM requests WHERE id=?').bind(f.request.id).first();
  assert.equal(after.message_version, 0);
  assert.equal(after.latest_message_at, null);
  delete after.message_version; delete after.latest_message_at;
  assert.deepEqual(after, before);
  const saved = await f.store.addRequestMessage(f.employee.session, f.request.id, note());
  assert.equal(saved.request.messages.length, 1);
});
