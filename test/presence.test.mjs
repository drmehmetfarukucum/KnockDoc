import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Store } from '../src/store.mjs';
import { createWorker } from '../src/worker.mjs';
import { AppError, RETENTION_MS, localTime } from '../src/rules.mjs';
import { createD1Fixture, DAY } from './d1-fixture.mjs';

const ORIGIN = 'https://revir.example.test';
const allowed = { limit: async () => ({ success: true }) };

async function setup(t) {
  const f = await createD1Fixture();
  t.after(() => f.dispose());
  const employee = await f.createWorker();
  const created = (await f.store.createRequest(employee.session, {
    operationId: crypto.randomUUID(), formDate: localTime(f.clock.value).date,
    note: 'Sentetik bekleme durumu testi',
  })).request;
  const answered = (await f.store.answer(created.id, {
    expectedVersion: created.version, text: 'Yaklaşık on dakika içinde geleceğim.',
  })).request;
  return { ...f, employee, created, answered };
}

function choice(request, presence, extra = {}) {
  return { presence, expectedVersion: request.version, expectedReplyVersion: request.replyVersion, ...extra };
}

async function rejects(operation, status, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

function http(f, push = { sendAll: async () => {} }) {
  const worker = createWorker({ makeStore: () => f.store, makePush: () => push });
  const env = { DB: f.db, SUBMIT_LIMIT: allowed, PUBLIC_LIMIT: allowed, SESSION_LIMIT: allowed };
  const cookie = `__Host-revir_worker=${f.employee.token}`;
  const fetch = (path, { method = 'POST', body, headers = {}, session = f.employee, noCsrf = false } = {}, ctx) => {
    const requestHeaders = new Headers({ origin: ORIGIN, 'content-type': 'application/json', ...headers });
    if (session) {
      requestHeaders.set('cookie', `__Host-revir_worker=${session.token}`);
      if (!noCsrf) requestHeaders.set('x-csrf-token', session.session.csrf);
    }
    return worker.fetch(new Request(ORIGIN + path, {
      method, headers: requestHeaders,
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }), env, ctx);
  };
  return { worker, env, fetch, cookie, path: `/api/requests/${f.answered.id}/presence` };
}

test('new requests have unspecified presence and both private views expose saved feedback without owner data', async t => {
  const f = await setup(t);
  assert.equal(f.created.presence, null);
  assert.equal(f.created.presenceUpdatedAt, null);
  assert.equal(f.created.replyVersion, 0);
  assert.equal(f.answered.replyVersion, f.answered.version);
  assert.equal(f.answered.presence, null);
  f.clock.value += 60_000;
  const result = await f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'waiting'));
  assert.equal(result.changed, true);
  assert.equal(result.request.presence, 'waiting');
  assert.equal(result.request.presenceUpdatedAt, new Date(f.clock.value).toISOString());
  assert.equal(result.request.replyVersion, f.answered.replyVersion);
  assert.equal(result.request.version, f.answered.version + 1);
  for (const state of [await f.store.publicState(f.employee.session), await f.store.doctorState()]) {
    assert.deepEqual(state.requests[0], result.request);
    assert.equal('owner' in state.requests[0], false);
    assert.equal('presence_updated' in state.requests[0], false);
  }
});

test('presence works after hours and changing a choice never extends request or session retention', async t => {
  const f = await setup(t);
  const beforeSession = await f.store.session(f.employee.token);
  f.clock.value += 14 * 60 * 60 * 1000;
  assert.equal((await f.store.publicState(f.employee.session)).availability.accepting, false);
  const left = await f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'left'));
  f.clock.value += 60_000;
  const waiting = await f.store.updatePresence(f.employee.session, f.answered.id, choice(left.request, 'waiting'));
  assert.equal(waiting.request.presence, 'waiting');
  assert.notEqual(waiting.request.presenceUpdatedAt, left.request.presenceUpdatedAt);
  assert.equal(waiting.request.expiresAt, f.answered.expiresAt);
  assert.equal((await f.store.session(f.employee.token)).expires, beforeSession.expires);
});

test('same-choice lost-response retry is a no-op but a stale different choice cannot overwrite current feedback', async t => {
  const f = await setup(t);
  const body = choice(f.answered, 'left');
  const saved = await f.store.updatePresence(f.employee.session, f.answered.id, body);
  f.clock.value += 60_000;
  const retry = await f.store.updatePresence(f.employee.session, f.answered.id, body);
  assert.equal(retry.changed, false);
  assert.deepEqual(retry.request, saved.request);
  await rejects(f.store.updatePresence(f.employee.session, f.answered.id, { ...body, presence: 'waiting' }), 409, 'VERSION_CONFLICT');
});

test('simultaneous identical choices change once; a competing new doctor answer cannot also win', async t => {
  const f = await setup(t);
  const identical = await Promise.all(Array.from({ length: 6 }, () => f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'waiting'))));
  assert.equal(identical.filter(result => result.changed).length, 1);
  assert.equal(new Set(identical.map(result => result.request.version)).size, 1);
  const current = identical[0].request;
  const competing = await Promise.allSettled([
    f.store.updatePresence(f.employee.session, current.id, choice(current, 'left')),
    f.store.answer(current.id, { expectedVersion: current.version, text: 'Yeni hekim yanıtı' }),
  ]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = competing.find(result => result.status === 'rejected').reason;
  assert.equal(rejection.status, 409);
  const final = (await f.store.publicState(f.employee.session)).requests[0];
  if (final.reply === 'Yeni hekim yanıtı') {
    assert.equal(final.presence, null);
    assert.ok(final.replyVersion > current.replyVersion);
  } else {
    assert.equal(final.presence, 'left');
    assert.equal(final.replyVersion, current.replyVersion);
  }
});

test('simultaneous opposite choices and completion races accept only one versioned change', async t => {
  for (const competitor of ['opposite-choice', 'complete']) {
    const f = await setup(t);
    const changes = await Promise.allSettled([
      f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'left')),
      competitor === 'opposite-choice'
        ? f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'waiting'))
        : f.store.complete(f.answered.id, { expectedVersion: f.answered.version }),
    ]);
    assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1, competitor);
    assert.equal(changes.find(result => result.status === 'rejected').reason.status, 409, competitor);
    const final = (await f.store.publicState(f.employee.session)).requests[0];
    assert.equal(final.version, f.answered.version + 1, competitor);
    if (final.status === 'done') assert.equal(final.presence, null);
    else assert.ok(['waiting', 'left'].includes(final.presence));
  }
});

test('complete and reopen preserve feedback; a new answer clears it even with same text and timestamp', async t => {
  const f = await setup(t);
  const waiting = (await f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'waiting'))).request;
  const done = (await f.store.complete(waiting.id, { expectedVersion: waiting.version })).request;
  assert.equal(done.presence, 'waiting');
  assert.equal(done.replyVersion, waiting.replyVersion);
  await rejects(f.store.updatePresence(f.employee.session, done.id, choice(done, 'left')), 409, 'PRESENCE_UNAVAILABLE');
  const reopened = (await f.store.reopen(done.id, { expectedVersion: done.version })).request;
  assert.equal(reopened.presence, 'waiting');
  assert.equal(reopened.presenceUpdatedAt, waiting.presenceUpdatedAt);
  assert.equal(reopened.replyVersion, waiting.replyVersion);
  const newAnswer = (await f.store.answer(reopened.id, { expectedVersion: reopened.version, text: reopened.reply })).request;
  assert.equal(newAnswer.repliedAt, reopened.repliedAt);
  assert.equal(newAnswer.reply, reopened.reply);
  assert.equal(newAnswer.presence, null);
  assert.equal(newAnswer.presenceUpdatedAt, null);
  assert.ok(newAnswer.replyVersion > reopened.replyVersion);
  await rejects(f.store.updatePresence(f.employee.session, newAnswer.id, choice(waiting, 'waiting')), 409, 'VERSION_CONFLICT');
});

test('other owners, missing or expired requests, expired sessions and unanswered requests cannot accept feedback', async t => {
  const f = await setup(t);
  const other = await f.createWorker();
  const body = choice(f.answered, 'left');
  await rejects(f.store.updatePresence(other.session, f.answered.id, body), 404, 'NOT_FOUND');
  await rejects(f.store.updatePresence(f.employee.session, crypto.randomUUID(), body), 404, 'NOT_FOUND');
  const pending = (await f.store.createRequest(f.employee.session, { operationId: crypto.randomUUID(), formDate: localTime(f.clock.value).date })).request;
  await rejects(f.store.updatePresence(f.employee.session, pending.id, choice(pending, 'waiting', { expectedReplyVersion: 1 })), 409, 'PRESENCE_UNAVAILABLE');
  // A newer request may renew the session, but never renews this older request.
  f.clock.value += DAY;
  await f.store.createRequest(f.employee.session, { operationId: crypto.randomUUID(), formDate: localTime(f.clock.value).date });
  f.clock.value += RETENTION_MS - DAY;
  await rejects(f.store.updatePresence(f.employee.session, f.answered.id, body), 404, 'NOT_FOUND');
  f.clock.value += DAY;
  await rejects(f.store.updatePresence(f.employee.session, f.answered.id, body), 401, 'SESSION_EXPIRED');
});

test('invalid presence and missing or malformed versions are rejected before changing a record', async t => {
  const f = await setup(t);
  for (const presence of [null, '', 'arrived', 'WAITING', {}, ['left']]) {
    await rejects(f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, presence)), 400, 'INVALID_PRESENCE');
  }
  for (const extra of [{ expectedVersion: undefined }, { expectedVersion: '2' }, { expectedVersion: 0 },
    { expectedReplyVersion: undefined }, { expectedReplyVersion: 0 }, { expectedReplyVersion: '2' },
    { expectedReplyVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
    await rejects(f.store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'left', extra)), 409, 'VERSION_CONFLICT');
  }
  assert.equal((await f.store.publicState(f.employee.session)).requests[0].presence, null);
});

test('write boundary rechecks ownership, request expiry and session validity after the initial read', async t => {
  for (const race of ['owner', 'request-expiry', 'session-expiry']) {
    const f = await setup(t);
    const other = await f.createWorker();
    const racingDb = {
      prepare: sql => f.db.prepare(sql),
      async batch(statements) {
        if (race === 'owner') await f.db.prepare('UPDATE requests SET owner=? WHERE id=?').bind(other.session.hash, f.answered.id).run();
        if (race === 'request-expiry') await f.db.prepare('UPDATE requests SET expires=? WHERE id=?').bind(f.clock.value, f.answered.id).run();
        if (race === 'session-expiry') await f.db.prepare('UPDATE sessions SET expires=? WHERE hash=?').bind(f.clock.value, f.employee.session.hash).run();
        return f.db.batch(statements);
      },
    };
    const store = new Store(racingDb, () => f.clock.value);
    await rejects(store.updatePresence(f.employee.session, f.answered.id, choice(f.answered, 'left')), race === 'session-expiry' ? 401 : 404);
    const row = await f.db.prepare('SELECT presence,version FROM requests WHERE id=?').bind(f.answered.id).first();
    assert.equal(row.presence, null, race);
    assert.equal(row.version, f.answered.version, race);
  }
});

test('HTTP presence uses employee CSRF, same-origin and both submission rate gates without exposing another owner', async t => {
  const f = await setup(t);
  const h = http(f);
  const body = choice(f.answered, 'left');
  for (const [options, expected] of [
    [{ session: null }, 401], [{ noCsrf: true }, 403],
    [{ headers: { origin: 'https://foreign.example.test' } }, 403],
    [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403],
  ]) assert.equal((await h.fetch(h.path, { body, ...options })).status, expected);
  const other = await f.createWorker();
  const foreign = await h.fetch(h.path, { body, session: other });
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(await foreign.text(), /Sentetik|Yaklaşık|presenceUpdatedAt|replyVersion/);
  const rateKeys = [];
  h.env.SUBMIT_LIMIT = { limit: async ({ key }) => { rateKeys.push(key); return { success: !key.includes(':ip:') }; } };
  assert.equal((await h.fetch(h.path, { body })).status, 429);
  assert.equal(rateKeys.length, 2);
  assert.ok(rateKeys[0].includes(':owner:'));
  assert.ok(rateKeys[1].includes(':ip:'));
  assert.equal((await f.store.doctorState()).requests[0].presence, null);
});

test('HTTP route whitelist and body validation cannot fall through to creating requests or reading assets', async t => {
  const f = await setup(t);
  const h = http(f);
  let assetReads = 0;
  h.env.ASSETS = { fetch: async () => { assetReads++; return new Response('private'); } };
  for (const path of [h.path + '/', h.path.replace('/presence', '/unknown'), '/api/requests/not-a-uuid/presence',
    '/api/requests/' + '-'.repeat(36) + '/presence']) {
    assert.equal((await h.fetch(path, { body: choice(f.answered, 'waiting') })).status, 404, path);
  }
  for (const method of ['GET', 'HEAD']) assert.equal((await h.fetch(h.path, { method })).status, 404);
  assert.equal((await h.fetch(h.path, { method: 'DELETE' })).status, 405);
  for (const [options, expected] of [[{ body: '{' }, 400], [{ body: [] }, 400],
    [{ body: 'x'.repeat(16385) }, 413], [{ body: {}, headers: { 'content-type': 'text/plain' } }, 415]]) {
    assert.equal((await h.fetch(h.path, options)).status, expected);
  }
  assert.equal(assetReads, 0);
  assert.equal((await f.store.doctorState()).requests.length, 1);
  assert.equal((await f.store.doctorState()).requests[0].presence, null);
});

test('HTTP simultaneous feedback sends one coded push per actual change including returning to waiting', async t => {
  const f = await setup(t);
  const calls = [];
  const h = http(f, { sendAll: async (...args) => calls.push(args) });
  const leftBody = choice(f.answered, 'left');
  const responses = await Promise.all(Array.from({ length: 5 }, () => h.fetch(h.path, { body: leftBody })));
  assert.ok(responses.every(response => response.status === 200));
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results.filter(result => result.changed).length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [h.env, { event: { type: 'left', code: f.answered.visitorCode, day: f.answered.visitorDay } }]);
  assert.equal(responses[0].headers.get('set-cookie'), null);
  const saved = results[0].request;
  const waiting = await h.fetch(h.path, { body: choice(saved, 'waiting') });
  assert.equal(waiting.status, 200);
  assert.equal((await waiting.json()).changed, true);
  assert.equal(calls.length, 2);
  const stale = await h.fetch(h.path, { body: leftBody });
  assert.equal(stale.status, 409);
  assert.equal(calls.length, 2);
});

test('push rejection does not roll back saved left feedback, and retry never repeats the failed notification', async t => {
  const f = await setup(t);
  let sends = 0;
  const h = http(f, { sendAll: async () => { sends++; throw new Error('synthetic provider rejection'); } });
  const background = [];
  const body = choice(f.answered, 'left');
  const response = await h.fetch(h.path, { body }, { waitUntil: promise => background.push(promise) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).request.presence, 'left');
  assert.equal(background.length, 1);
  await Promise.all(background);
  assert.equal(sends, 1);
  const retry = await h.fetch(h.path, { body });
  assert.equal((await retry.json()).changed, false);
  assert.equal(sends, 1);
  assert.equal((await f.store.doctorState()).requests[0].presence, 'left');
});

test('existing-install migration preserves requests, operation mappings, settings, authentication and push records', async t => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  const legacySchema = schema.split('\n').filter(line => !/^\s+(presence |presence_updated |reply_version )/.test(line)).join('\n');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default { fetch() { return new Response("test"); } };', d1Databases: { DB: 'presence-legacy' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const exec = async source => db.exec(source.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean).map(sql => sql.replaceAll('\n', ' ')).join('\n'));
  await exec(legacySchema);
  const owner = 'synthetic-owner', expiry = Date.now() + RETENTION_MS;
  await db.prepare('INSERT INTO sessions(hash,csrf,expires) VALUES(?,?,?)').bind(owner, 'synthetic-csrf', expiry).run();
  for (const [id, status, reply, version] of [['unanswered', 'new', '', 1], ['answered', 'answered', 'Önceki yanıt', 4], ['completed', 'done', 'Tamamlanan yanıt', 8]]) {
    await db.prepare(`INSERT INTO requests(id,owner,created_day,created,expires,status,note,phone,full_name,reply,replied,version)
      VALUES(?,?,'2026-10-05',1,?,?,'Eski not','','',?,?,?)`).bind(id, owner, expiry, status, reply, reply ? 2 : null, version).run();
    await db.prepare('INSERT INTO request_operations(owner,operation_id,request_id) VALUES(?,?,?)').bind(owner, id + '-op', id).run();
  }
  await db.prepare("INSERT INTO doctor_sessions(hash,csrf,expires,authenticated,credential_version) VALUES('doctor','csrf',?,1,'credential')").bind(expiry).run();
  await db.prepare("INSERT INTO doctor_login_limits(scope,expires,attempts) VALUES('attempt-scope',?,1)").bind(expiry).run();
  await db.prepare(`INSERT INTO doctor_push_subscriptions(hash,endpoint,credential_version,vapid_public_key,session_hash,created,updated,expires)
    VALUES('push','https://web.push.apple.com/synthetic','credential','public-key','doctor',1,2,?)`).bind(expiry).run();
  const tables = ['sessions', 'requests', 'request_operations', 'config', 'doctor_sessions', 'doctor_login_limits', 'doctor_push_subscriptions'];
  const before = Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.prepare(`SELECT * FROM ${table}`).all()).results])));
  const migration = await readFile(new URL('../migrations/0002_worker_presence.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|REPLACE)\b/i);
  await exec(migration);
  for (const table of tables) {
    const after = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
    if (table !== 'requests') assert.deepEqual(after, before[table], table);
    else for (const row of after) {
      const { presence, presence_updated, reply_version, ...original } = row;
      assert.deepEqual(original, before.requests.find(item => item.id === row.id));
      assert.equal(presence, null);
      assert.equal(presence_updated, null);
      assert.equal(reply_version, row.reply ? row.version : 0);
    }
  }
  for (const field of ["presence='invalid'", 'reply_version=-1', 'reply_version=NULL']) {
    await assert.rejects(db.prepare(`UPDATE requests SET ${field} WHERE id='answered'`).run());
  }
});
