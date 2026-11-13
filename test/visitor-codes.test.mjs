import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Store } from '../src/store.mjs';
import { createWorker } from '../src/worker.mjs';
import { AppError, RETENTION_MS, localTime, record } from '../src/rules.mjs';
import { createD1Fixture, DAY, MONDAY_0900_ISTANBUL } from './d1-fixture.mjs';

async function setup(t) {
  const f = await createD1Fixture();
  t.after(() => f.dispose());
  return { ...f, employee: await f.createWorker() };
}

function body(f, extra = {}) {
  return { operationId: randomUUID(), formDate: localTime(f.clock.value).date, ...extra };
}

async function count(db, table) {
  return (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count;
}

async function rejects(promise, status, code) {
  await assert.rejects(promise, error => error instanceof AppError && error.status === status && error.code === code);
}

test('daily codes allocate once per anonymous session despite concurrent requests and operation retries', async t => {
  const f = await setup(t);
  const employees = [f.employee, await f.createWorker(), await f.createWorker()];
  const inputs = employees.map(() => Array.from({ length: 3 }, () => body(f)));
  const submitted = await Promise.all(employees.map(async (employee, index) =>
    Promise.all(inputs[index].map(input => f.store.createRequest(employee.session, input)))));
  const numbers = submitted.map(results => {
    assert.ok(results.every(result => result.created));
    assert.equal(new Set(results.map(result => result.request.visitorNumber)).size, 1);
    for (const result of results) {
      assert.equal(result.request.visitorDay, '2026-10-05');
      assert.equal(result.request.visitorCode, `Pzt-${result.request.visitorNumber}`);
      assert.equal('owner' in result.request, false);
    }
    return results[0].request.visitorNumber;
  });
  assert.deepEqual(numbers.toSorted((a, b) => a - b), [1, 2, 3]);
  const retries = await Promise.all(Array.from({ length: 6 }, () => f.store.createRequest(employees[0].session, inputs[0][0])));
  assert.ok(retries.every(result => !result.created));
  assert.ok(retries.every(result => result.request.id === submitted[0][0].request.id));
  assert.equal((await f.db.prepare('SELECT last_number FROM daily_visitor_counters').first()).last_number, 3);
  assert.equal(await count(f.db, 'daily_visitors'), 3);
  assert.equal(await count(f.db, 'requests'), 9);
  const state = await f.store.publicState(employees[0].session);
  assert.equal(state.requests.length, 3);
  assert.ok(state.requests.every(request => request.visitorCode === submitted[0][0].request.visitorCode));
  assert.equal((await f.store.doctorState()).requests.length, 9);
});

test('daily numbering resets at Istanbul midnight while an old operation preserves its original code', async t => {
  const f = await setup(t);
  const settings = await f.store.settings();
  settings.schedule = settings.schedule.map(() => ({ open: true, start: '00:00', end: '23:59' }));
  await f.db.prepare('UPDATE config SET value=? WHERE id=1').bind(JSON.stringify(settings)).run();
  f.clock.value = Date.parse('2026-10-05T20:58:00Z'); // Monday23.58 in Istanbul.
  const originalInput = body(f);
  const monday = (await f.store.createRequest(f.employee.session, originalInput)).request;
  const other = await f.createWorker();
  const otherMonday = (await f.store.createRequest(other.session, body(f))).request;
  assert.equal(monday.visitorCode, 'Pzt-1');
  assert.equal(otherMonday.visitorCode, 'Pzt-2');
  f.clock.value = Date.parse('2026-10-05T21:00:00Z'); // Still MondayUTC, Tuesday00.00 Istanbul.
  const tuesday = (await f.store.createRequest(other.session, body(f))).request;
  assert.equal(tuesday.visitorDay, '2026-10-06');
  assert.equal(tuesday.visitorCode, 'Salı-1');
  const retry = await f.store.createRequest(f.employee.session, originalInput);
  assert.equal(retry.created, false);
  assert.equal(retry.request.visitorCode, 'Pzt-1');
  assert.equal(retry.request.visitorDay, '2026-10-05');
  assert.deepEqual((await f.db.prepare('SELECT day,last_number FROM daily_visitor_counters ORDER BY day').all()).results,
    [{ day: '2026-10-05', last_number: 2 }, { day: '2026-10-06', last_number: 1 }]);
});

test('page reads and rejected closed, stale, malformed or expired-session submissions consume no daily numbers', async t => {
  const f = await setup(t);
  await f.store.publicState(f.employee.session);
  await f.store.publicState(f.employee.session);
  await f.store.doctorState();
  assert.equal(await count(f.db, 'daily_visitor_counters'), 0);
  await rejects(f.store.createRequest(f.employee.session, body(f, { formDate: '2026-10-04' })), 409, 'STALE_FORM');
  await rejects(f.store.createRequest(f.employee.session, body(f, { note: 'x'.repeat(301) })), 400, 'INVALID_FIELD');
  const settings = await f.store.settings();
  settings.todayOverride = { date: localTime(f.clock.value).date, open: false, start: '08:00', end: '17:00', message: '' };
  await f.db.prepare('UPDATE config SET value=? WHERE id=1').bind(JSON.stringify(settings)).run();
  await rejects(f.store.createRequest(f.employee.session, body(f)), 409, 'CLOSED');
  settings.todayOverride = null;
  await f.db.prepare('UPDATE config SET value=? WHERE id=1').bind(JSON.stringify(settings)).run();
  // Expire the session after the initial read, immediately before the write transaction.
  const racingStore = new Store({
    prepare: sql => f.db.prepare(sql),
    async batch(statements) {
      await f.db.prepare('UPDATE sessions SET expires=? WHERE hash=?').bind(f.clock.value, f.employee.session.hash).run();
      return f.db.batch(statements);
    },
  }, () => f.clock.value);
  await rejects(racingStore.createRequest(f.employee.session, body(f)), 401, 'SESSION_EXPIRED');
  assert.equal(await count(f.db, 'requests'), 0);
  assert.equal(await count(f.db, 'daily_visitors'), 0);
  assert.equal(await count(f.db, 'daily_visitor_counters'), 0);
});

test('a settings-version race that closes submissions cannot reserve or consume a daily code', async t => {
  const f = await setup(t);
  let batches = 0;
  const racingStore = new Store({
    prepare: sql => f.db.prepare(sql),
    async batch(statements) {
      batches++;
      const settings = await f.store.settings();
      settings.version++;
      settings.todayOverride = { date: localTime(f.clock.value).date, open: false, start: '08:00', end: '17:00', message: '' };
      await f.db.prepare('UPDATE config SET value=? WHERE id=1').bind(JSON.stringify(settings)).run();
      return f.db.batch(statements);
    },
  }, () => f.clock.value);
  await rejects(racingStore.createRequest(f.employee.session, body(f)), 409, 'CLOSED');
  assert.equal(batches, 1);
  assert.equal(await count(f.db, 'requests'), 0);
  assert.equal(await count(f.db, 'daily_visitors'), 0);
  assert.equal(await count(f.db, 'daily_visitor_counters'), 0);
});

test('daily alias retention equals its last request expiry and presence never extends it', async t => {
  const f = await setup(t);
  const input = body(f);
  const first = (await f.store.createRequest(f.employee.session, input)).request;
  f.clock.value += 2 * 60 * 60 * 1000;
  const second = (await f.store.createRequest(f.employee.session, body(f))).request;
  const expiry = Date.parse(second.expiresAt);
  assert.equal(first.visitorCode, second.visitorCode);
  assert.equal((await f.db.prepare('SELECT expires FROM daily_visitors').first()).expires, expiry);
  const answered = (await f.store.answer(second.id, { expectedVersion: second.version, text: 'Sentetik yanıt' })).request;
  f.clock.value += 60_000;
  await f.store.updatePresence(f.employee.session, second.id, { presence: 'waiting', expectedVersion: answered.version, expectedReplyVersion: answered.replyVersion });
  await f.store.createRequest(f.employee.session, input); // A retry cannot renew any expiry.
  assert.equal((await f.db.prepare('SELECT expires FROM daily_visitors').first()).expires, expiry);
  assert.equal((await f.store.session(f.employee.token)).expires, expiry);
  f.clock.value = Date.parse(first.expiresAt);
  assert.deepEqual(await f.store.cleanup(), { requestsDeleted: 1, sessionsDeleted: 0 });
  assert.equal(await count(f.db, 'daily_visitors'), 1);
  assert.equal((await f.store.publicState(f.employee.session)).requests[0].id, second.id);
  f.clock.value = expiry;
  assert.deepEqual(await f.store.cleanup(), { requestsDeleted: 1, sessionsDeleted: 1 });
  assert.equal(await count(f.db, 'daily_visitors'), 0);
  assert.equal(await count(f.db, 'daily_visitor_counters'), 1);
  f.clock.value = MONDAY_0900_ISTANBUL + 9 * DAY;
  await f.store.cleanup();
  assert.equal(await count(f.db, 'daily_visitor_counters'), 0);
});

test('removing a session cascades private daily aliases but never reuses its allocated number', async t => {
  const f = await setup(t);
  const original = (await f.store.createRequest(f.employee.session, body(f))).request;
  assert.equal(original.visitorCode, 'Pzt-1');
  await f.db.prepare('DELETE FROM sessions WHERE hash=?').bind(f.employee.session.hash).run();
  assert.equal(await count(f.db, 'daily_visitors'), 0);
  assert.equal(await count(f.db, 'requests'), 0);
  const replacement = await f.createWorker();
  assert.equal((await f.store.createRequest(replacement.session, body(f))).request.visitorCode, 'Pzt-2');
});

test('legacy backfill groups by session and creation day, preserves every existing field and continues daily counters', async t => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  const legacySchema = schema.replace(/^\s+visitor_number .*\n/m, '')
    .replace(/-- Anonymous daily queue codes[\s\S]*?(?=CREATE TABLE IF NOT EXISTS request_operations)/, '');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default { fetch() { return new Response("test"); } };', d1Databases: { DB: 'visitor-legacy' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const exec = source => db.exec(source.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean)
    .map(sql => sql.replaceAll('\n', ' ')).join('\n'));
  await exec(legacySchema);
  const now = MONDAY_0900_ISTANBUL + DAY, expiry = now + RETENTION_MS;
  for (const owner of ['owner-a', 'owner-b']) {
    await db.prepare('INSERT INTO sessions(hash,csrf,expires) VALUES(?,?,?)').bind(owner, owner + '-csrf', expiry).run();
  }
  const operations = [];
  for (const [owner, day, status] of [
    ['owner-b', '2026-10-05', 'done'], ['owner-a', '2026-10-05', 'answered'],
    ['owner-b', '2026-10-05', 'new'], ['owner-a', '2026-10-06', 'answered'],
  ]) {
    const id = randomUUID(), operationId = randomUUID();
    await db.prepare(`INSERT INTO requests(id,owner,created_day,created,expires,status,note,phone,full_name,reply,replied,presence,presence_updated,reply_version,completed,completed_from,version)
      VALUES(?,?,?,?,?,?,'Eski not','000','Örnek ad','Eski yanıt',?,'left',?,3,?,'answered',5)`)
      .bind(id, owner, day, now - DAY, expiry, status, now - 1000, now - 500, status === 'done' ? now : null).run();
    await db.prepare('INSERT INTO request_operations(owner,operation_id,request_id) VALUES(?,?,?)').bind(owner, operationId, id).run();
    operations.push({ id, operationId, owner, day });
  }
  await db.prepare("INSERT INTO doctor_sessions(hash,csrf,expires,authenticated,credential_version) VALUES('doctor','csrf',?,1,'credential')").bind(expiry).run();
  await db.prepare("INSERT INTO doctor_login_limits(scope,expires,attempts) VALUES('attempt-scope',?,2)").bind(expiry).run();
  await db.prepare(`INSERT INTO doctor_push_subscriptions(hash,endpoint,credential_version,vapid_public_key,session_hash,created,updated,expires)
    VALUES('push','https://web.push.apple.com/synthetic','credential','public-key','doctor',1,2,?)`).bind(expiry).run();
  const tables = ['sessions', 'requests', 'request_operations', 'config', 'doctor_sessions', 'doctor_login_limits', 'doctor_push_subscriptions'];
  const before = Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.prepare(`SELECT * FROM ${table}`).all()).results])));
  const migration = await readFile(new URL('../migrations/0003_daily_visitor_codes.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /^\s*(?:DROP|DELETE|REPLACE)\b/im);
  await exec(migration);
  for (const table of tables) {
    const rows = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
    if (table !== 'requests') assert.deepEqual(rows, before[table], table);
    else for (const row of rows) {
      const { visitor_number, ...oldFields } = row;
      assert.deepEqual(oldFields, before.requests.find(item => item.id === row.id));
      assert.equal(visitor_number, row.created_day === '2026-10-05' && row.owner === 'owner-a' ? 2 : 1);
      assert.match(record(row).visitorCode, /^(Pzt|Salı)-[12]$/);
    }
  }
  assert.deepEqual((await db.prepare('SELECT day,last_number FROM daily_visitor_counters ORDER BY day').all()).results,
    [{ day: '2026-10-05', last_number: 2 }, { day: '2026-10-06', last_number: 1 }]);
  const store = new Store(db, () => now);
  const credentials = await store.createSession();
  const newcomer = await store.session(credentials.token);
  assert.equal((await store.createRequest(newcomer, { operationId: randomUUID(), formDate: '2026-10-06' })).request.visitorCode, 'Salı-2');
  const original = operations[0];
  const retry = await store.createRequest({ hash: original.owner }, { operationId: original.operationId, formDate: original.day });
  assert.equal(retry.created, false);
  assert.equal(retry.request.id, original.id);
  assert.equal(retry.request.visitorCode, 'Pzt-1');
  await assert.rejects(db.prepare('UPDATE requests SET visitor_number=0').run());
});

test('HTTP notifications cover new requests and both actual presence changes exactly once with anonymous data only', async t => {
  const f = await setup(t);
  const events = [];
  const push = { sendAll: async (_env, options) => { events.push(options.event); } };
  const worker = createWorker({ makeStore: () => f.store, makePush: () => push });
  const allowed = { limit: async () => ({ success: true }) };
  const env = { DB: f.db, SUBMIT_LIMIT: allowed, PUBLIC_LIMIT: allowed, SESSION_LIMIT: allowed };
  const post = (path, payload) => worker.fetch(new Request('https://revir.example.test' + path, {
    method: 'POST', headers: { origin: 'https://revir.example.test', 'content-type': 'application/json',
      cookie: `__Host-revir_worker=${f.employee.token}`, 'x-csrf-token': f.employee.session.csrf },
    body: JSON.stringify(payload),
  }), env);
  const input = body(f, { note: 'Özel not', fullName: 'Sentetik isim', phone: '000' });
  const creation = await post('/api/requests', input);
  assert.equal(creation.status, 201);
  const request = (await creation.json()).request;
  const answered = (await f.store.answer(request.id, { expectedVersion: request.version, text: 'Özel hekim yanıtı' })).request;
  const path = `/api/requests/${request.id}/presence`;
  const choice = (current, presence) => ({ presence, expectedVersion: current.version, expectedReplyVersion: current.replyVersion });
  const change = async (current, presence) => {
    const res = await post(path, choice(current, presence));
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  const waiting = await change(answered, 'waiting');
  assert.equal(waiting.changed, true);
  assert.equal((await change(answered, 'waiting')).changed, false); // Lost-response retry.
  const left = await change(waiting.request, 'left');
  f.clock.value += 2 * 60 * 60 * 1000;
  const returned = await change(left.request, 'waiting');
  assert.equal(returned.changed, true);
  assert.equal(returned.request.presence, 'waiting');
  assert.equal((await post('/api/requests', input)).status, 200);
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => change(returned.request, 'left')));
  assert.equal(concurrent.filter(result => result.changed).length, 1);
  assert.deepEqual(events, ['new', 'waiting', 'left', 'waiting', 'left'].map(type => ({ type, code: 'Pzt-1', day: '2026-10-05' })));
  assert.doesNotMatch(JSON.stringify(events), /Özel|Sentetik|000|owner|phone|fullName|reply/);
});

test('postdeploy repair is idempotent and fills only missing owner/day codes without renumbering or extending request retention', async t => {
  const f = await setup(t);
  const assigned = (await f.store.createRequest(f.employee.session, body(f))).request;
  const other = await f.createWorker();
  const inserted = [];
  for (const [employee, hours] of [[f.employee, 1], [other, 2], [other, 3]]) {
    const id = randomUUID(), created = f.clock.value + hours * 60 * 60 * 1000;
    await f.db.prepare(`INSERT INTO requests(id,owner,created_day,created,expires,status,note,phone,full_name)
      VALUES(?,?,'2026-10-05',?,?,'new','','','')`).bind(id, employee.session.hash, created, created + RETENTION_MS).run();
    inserted.push({ id, expires: created + RETENTION_MS, owner: employee.session.hash });
  }
  const repair = await readFile(new URL('../scripts/repair-visitor-codes.sql', import.meta.url), 'utf8');
  const statements = repair.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
  const runRepair = () => f.db.batch(statements.map(sql => f.db.prepare(sql)));
  await runRepair();
  const firstSnapshot = (await f.db.prepare('SELECT * FROM requests ORDER BY seq').all()).results;
  await runRepair();
  assert.deepEqual((await f.db.prepare('SELECT * FROM requests ORDER BY seq').all()).results, firstSnapshot);
  assert.equal(firstSnapshot.find(row => row.id === assigned.id).visitor_number, 1);
  assert.equal(firstSnapshot.find(row => row.id === inserted[0].id).visitor_number, 1);
  assert.ok(inserted.slice(1).every(input => firstSnapshot.find(row => row.id === input.id).visitor_number === 2));
  for (const input of inserted) assert.equal(firstSnapshot.find(row => row.id === input.id).expires, input.expires);
  assert.equal((await f.db.prepare('SELECT last_number FROM daily_visitor_counters').first()).last_number, 2);
  for (const employee of [f.employee, other]) {
    assert.equal((await f.db.prepare('SELECT expires FROM daily_visitors WHERE owner=?').bind(employee.session.hash).first()).expires,
      Math.max(...inserted.filter(input => input.owner === employee.session.hash).map(input => input.expires)));
  }
  const newcomer = await f.createWorker();
  assert.equal((await f.store.createRequest(newcomer.session, body(f))).request.visitorCode, 'Pzt-3');
});
