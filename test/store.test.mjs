import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AppError, RETENTION_MS, localTime } from "../src/rules.mjs";
import { createD1Fixture, DAY, MONDAY_0900_ISTANBUL } from "./d1-fixture.mjs";

async function setup(t, now) {
  const fixture = await createD1Fixture(now);
  t.after(() => fixture.dispose());
  fixture.worker = await fixture.createWorker();
  return fixture;
}

function body(clock, extra = {}) {
  return { operationId: randomUUID(), formDate: localTime(clock.value).date, ...extra };
}

async function rejects(operation, status, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("two anonymous workers read only their own notes and replies", async t => {
  const { store, clock, worker, createWorker } = await setup(t);
  const other = await createWorker();
  const a = (await store.createRequest(worker.session, body(clock, { note: "A için örnek not", fullName: "Örnek Çalışan A" }))).request;
  const b = (await store.createRequest(other.session, body(clock, { note: "B için örnek not" }))).request;
  await store.answer(a.id, { expectedVersion: a.version, text: "A için örnek yanıt" });
  const aState = await store.publicState(worker.session);
  const bState = await store.publicState(other.session);
  assert.deepEqual(aState.requests.map(item => item.id), [a.id]);
  assert.deepEqual(bState.requests.map(item => item.id), [b.id]);
  assert.equal(aState.requests[0].reply, "A için örnek yanıt");
  assert.doesNotMatch(JSON.stringify(bState), /A için örnek|Örnek Çalışan A/);
  assert.equal((await store.doctorState()).requests.length, 2);
  assert.equal("owner" in aState.requests[0], false);
  assert.equal("seq" in aState.requests[0], false);
});

test("parallel different operation keys create distinct requests and keep each retry mapped across completion and midnight", async t => {
  const { store, clock, worker, db } = await setup(t);
  const submissions = Array.from({ length: 6 }, (_, index) => body(clock, { note: `Ayrı talep ${index}` }));
  const results = await Promise.all(submissions.map(input => store.createRequest(worker.session, input)));
  assert.equal(results.filter(item => item.created).length, submissions.length);
  assert.equal(new Set(results.map(item => item.request.id)).size, submissions.length);
  const done = await Promise.all(results.map(({ request }) => store.complete(request.id, { expectedVersion: request.version })));
  clock.value += DAY;
  const newer = (await store.createRequest(worker.session, body(clock, { note: "Ertesi gün ayrı talep" }))).request;
  for (const [index, input] of submissions.entries()) {
    const retry = await store.createRequest(worker.session, { ...input, note: "Eski talebi değiştirme" });
    assert.equal(retry.created, false);
    assert.equal(retry.request.id, results[index].request.id);
    assert.equal(retry.request.note, input.note);
    assert.equal(retry.request.status, "done");
    assert.equal(retry.request.version, done[index].request.version);
  }
  assert.equal((await store.doctorState()).requests.length, submissions.length + 1);
  assert.equal((await store.publicState(worker.session)).activeRequestId, newer.id);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM request_operations").first()).count, submissions.length + 1);
});

test("existing-install migration only drops the daily unique index, is repeatable and preserves data", async t => {
  const { store, clock, worker, db } = await setup(t);
  // Recreate the prior production restriction before applying the update.
  await db.exec("CREATE UNIQUE INDEX requests_one_active_daily ON requests(owner, created_day) WHERE status != 'done'");
  const input = body(clock, { note: "Güncellemeden önceki talep" });
  const original = (await store.createRequest(worker.session, input)).request;
  const migration = await readFile(new URL("../migrations/0001_allow_multiple_requests.sql", import.meta.url), "utf8");
  const statement = migration.replace(/^\s*--.*$/gm, "").trim();
  assert.equal(statement, "DROP INDEX IF EXISTS requests_one_active_daily;");
  await db.exec(statement);
  await db.exec(statement);
  const later = (await store.createRequest(worker.session, body(clock, { note: "Yeni ayrı talep" }))).request;
  assert.notEqual(later.id, original.id);
  assert.equal((await store.createRequest(worker.session, input)).request.id, original.id);
  assert.deepEqual((await store.publicState(worker.session)).requests.map(item => item.id), [later.id, original.id]);
  assert.ok(await store.session(worker.token));
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM request_operations").first()).count, 2);
  assert.equal((await store.settings()).version, 1);
});

test("parallel retries of the same operation create exactly one record", async t => {
  const { store, clock, worker, db } = await setup(t);
  const input = body(clock, { note: "Bir kez kaydedilmeli" });
  const results = await Promise.all(Array.from({ length: 6 }, () => store.createRequest(worker.session, input)));
  assert.equal(results.filter(item => item.created).length, 1);
  assert.equal(new Set(results.map(item => item.request.id)).size, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM requests").first()).count, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM request_operations").first()).count, 1);
});

test("reusing an operation after completion returns the original rather than a newer open visit", async t => {
  const { store, clock, worker } = await setup(t);
  const firstInput = body(clock, { note: "İlk geliş" });
  const first = (await store.createRequest(worker.session, firstInput)).request;
  await store.complete(first.id, { expectedVersion: first.version });
  const newer = (await store.createRequest(worker.session, body(clock, { note: "İkinci geliş" }))).request;
  const retry = await store.createRequest(worker.session, { ...firstInput, note: "Eski gönderim değiştirilmemeli" });
  assert.equal(retry.created, false);
  assert.equal(retry.request.id, first.id);
  assert.equal(retry.request.status, "done");
  assert.equal(retry.request.note, "İlk geliş");
  assert.equal((await store.publicState(worker.session)).activeRequestId, newer.id);
});

test("yesterday's active request does not block today's visit and stale new forms are rejected", async t => {
  const { store, clock, worker } = await setup(t);
  const monday = (await store.createRequest(worker.session, body(clock))).request;
  const stale = body(clock);
  clock.value += DAY;
  assert.equal((await store.publicState(worker.session)).activeRequestId, null);
  await rejects(() => store.createRequest(worker.session, stale), 409, "STALE_FORM");
  const tuesday = (await store.createRequest(worker.session, body(clock))).request;
  assert.notEqual(tuesday.id, monday.id);
  assert.equal((await store.publicState(worker.session)).activeRequestId, tuesday.id);
  assert.equal((await store.doctorState()).requests.length, 2);
});

test("server working hours include 08:00 and exclude 17:00 Istanbul", async t => {
  const { store, clock, worker, createWorker } = await setup(t, Date.parse("2026-10-05T04:59:59Z"));
  await rejects(() => store.createRequest(worker.session, body(clock)), 409, "CLOSED");
  clock.value = Date.parse("2026-10-05T05:00:00Z");
  assert.equal((await store.publicState(worker.session)).availability.accepting, true);
  assert.equal((await store.createRequest(worker.session, body(clock))).created, true);
  const other = await createWorker();
  clock.value = Date.parse("2026-10-05T13:59:59Z");
  assert.equal((await store.publicState(other.session)).availability.accepting, true);
  clock.value = Date.parse("2026-10-05T14:00:00Z");
  assert.equal((await store.publicState(other.session)).availability.accepting, false);
  await rejects(() => store.createRequest(other.session, body(clock)), 409, "CLOSED");
});

test("daily pause blocks new arrivals, keeps saved retries and resumes unchanged custom hours and physician note", async t => {
  const { store, clock, worker } = await setup(t);
  let settings = (await store.doctorState()).settings;
  settings = (await store.updateSettings({
    expectedVersion: settings.version, formDate: settings.formDate,
    todayOverride: { open: true, start: "08:30", end: "16:30", message: "İstasyondayım" },
    statusMessage: "Bugünkü hekim notu",
  })).settings;
  const input = body(clock);
  const original = (await store.createRequest(worker.session, input)).request;
  const paused = (await store.updateSettings({
    expectedVersion: settings.version, formDate: settings.formDate, pauseToday: true,
  })).settings;
  assert.equal(paused.pausedToday, true);
  assert.equal("pauseDate" in paused, false);
  assert.deepEqual(paused.schedule, settings.schedule);
  assert.deepEqual(paused.todayOverride, settings.todayOverride);
  assert.equal(paused.statusMessage, settings.statusMessage);
  const state = await store.publicState(worker.session);
  assert.equal(state.availability.accepting, false);
  assert.equal(state.availability.pausedToday, true);
  assert.equal(state.availability.detail, "Bugün talep alımı hekim tarafından kapatıldı.");
  assert.equal(state.availability.statusMessage, "İstasyondayım");
  await rejects(() => store.createRequest(worker.session, body(clock)), 409, "CLOSED");
  const retry = await store.createRequest(worker.session, input);
  assert.equal(retry.created, false);
  assert.equal(retry.request.id, original.id);
  const resumed = (await store.updateSettings({
    expectedVersion: paused.version, formDate: paused.formDate, pauseToday: false,
  })).settings;
  assert.equal(resumed.pausedToday, false);
  assert.deepEqual(resumed.todayOverride, settings.todayOverride);
  assert.equal((await store.createRequest(worker.session, body(clock))).created, true);
});

test("daily pause expires at Istanbul midnight and an old open screen cannot pause the new day", async t => {
  const { store, clock, worker } = await setup(t);
  const settings = (await store.doctorState()).settings;
  const paused = (await store.updateSettings({ expectedVersion: settings.version, formDate: settings.formDate, pauseToday: true })).settings;
  clock.value = Date.parse("2026-10-05T20:59:59.999Z");
  assert.equal((await store.doctorState()).settings.pausedToday, true);
  clock.value += 1;
  const tomorrow = await store.doctorState();
  assert.equal(tomorrow.settings.pausedToday, false);
  assert.equal(tomorrow.availability.pausedToday, false);
  await rejects(() => store.updateSettings({ expectedVersion: paused.version, formDate: paused.formDate, pauseToday: true }), 409, "STALE_FORM");
  clock.value = Date.parse("2026-10-06T06:00:00Z");
  assert.equal((await store.createRequest(worker.session, body(clock))).created, true);
});

test("concurrent pause and resume edits have one versioned winner", async t => {
  const { store } = await setup(t);
  const settings = (await store.doctorState()).settings;
  const updates = await Promise.allSettled([true, false, true, false].map(pauseToday =>
    store.updateSettings({ expectedVersion: settings.version, formDate: settings.formDate, pauseToday })));
  assert.equal(updates.filter(result => result.status === "fulfilled").length, 1);
  for (const rejected of updates.filter(result => result.status === "rejected")) {
    assert.equal(rejected.reason.code, "VERSION_CONFLICT");
  }
  assert.equal((await store.doctorState()).settings.pausedToday, updates.find(result => result.status === "fulfilled").value.settings.pausedToday);
});

test("a pause committed after arrival reads settings prevents the stale insert and visitor allocation", async t => {
  const { store, clock, worker, db } = await setup(t);
  const readSettings = store.settings.bind(store);
  let pauseCommitted = false;
  store.settings = async () => {
    const snapshot = await readSettings();
    if (!pauseCommitted) {
      pauseCommitted = true;
      await store.updateSettings({ expectedVersion: snapshot.version, formDate: localTime(clock.value).date, pauseToday: true });
    }
    return snapshot;
  };
  await rejects(() => store.createRequest(worker.session, body(clock)), 409, "CLOSED");
  assert.equal(pauseCommitted, true);
  for (const table of ["requests", "request_operations", "daily_visitors", "daily_visitor_counters"]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0);
  }
});

test("stale record and settings versions cannot overwrite newer changes", async t => {
  const { store, clock, worker } = await setup(t);
  const original = (await store.createRequest(worker.session, body(clock))).request;
  const answered = (await store.answer(original.id, { expectedVersion: original.version, text: "Güncel yanıt" })).request;
  await rejects(() => store.answer(original.id, { expectedVersion: original.version, text: "Eski ekranın yanıtı" }), 409, "VERSION_CONFLICT");
  await rejects(() => store.complete(original.id, { expectedVersion: original.version }), 409, "VERSION_CONFLICT");
  assert.equal((await store.doctorState()).requests[0].reply, answered.reply);
  const settings = (await store.doctorState()).settings;
  const update = { expectedVersion: settings.version, formDate: settings.formDate, statusMessage: "Güncel durum" };
  await store.updateSettings(update);
  await rejects(() => store.updateSettings({ ...update, statusMessage: "Eski durum" }), 409, "VERSION_CONFLICT");
  assert.equal((await store.doctorState()).settings.statusMessage, "Güncel durum");
});

test("concurrent answers and settings edits allow exactly one versioned winner", async t => {
  const { store, clock, worker } = await setup(t);
  const original = (await store.createRequest(worker.session, body(clock))).request;
  const answers = await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
    store.answer(original.id, { expectedVersion: original.version, text: `Yanıt ${index}` })));
  assert.equal(answers.filter(result => result.status === "fulfilled").length, 1);
  for (const result of answers.filter(result => result.status === "rejected")) {
    assert.equal(result.reason.status, 409);
    assert.equal(result.reason.code, "VERSION_CONFLICT");
  }
  const acceptedAnswer = answers.find(result => result.status === "fulfilled").value.request;
  assert.equal((await store.doctorState()).requests[0].reply, acceptedAnswer.reply);

  const settings = (await store.doctorState()).settings;
  const edits = await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
    store.updateSettings({ expectedVersion: settings.version, formDate: settings.formDate, statusMessage: `Durum ${index}` })));
  assert.equal(edits.filter(result => result.status === "fulfilled").length, 1);
  for (const result of edits.filter(result => result.status === "rejected")) {
    assert.equal(result.reason.status, 409);
    assert.equal(result.reason.code, "VERSION_CONFLICT");
  }
  const acceptedSettings = edits.find(result => result.status === "fulfilled").value.settings;
  assert.equal((await store.doctorState()).settings.statusMessage, acceptedSettings.statusMessage);
});

test("completion undo restores the answered state and preserves reply and retention dates", async t => {
  const { store, clock, worker } = await setup(t);
  const original = (await store.createRequest(worker.session, body(clock))).request;
  const answered = (await store.answer(original.id, { expectedVersion: original.version, text: "Örnek yanıt" })).request;
  clock.value += 60_000;
  const done = (await store.complete(answered.id, { expectedVersion: answered.version })).request;
  assert.equal(done.status, "done");
  const restored = (await store.reopen(done.id, { expectedVersion: done.version })).request;
  assert.equal(restored.status, "answered");
  assert.equal(restored.reply, answered.reply);
  assert.equal(restored.repliedAt, answered.repliedAt);
  assert.equal(restored.createdAt, original.createdAt);
  assert.equal(restored.expiresAt, original.expiresAt);
  assert.equal(restored.completedAt, null);
});

test("older completion can be undone alongside newer open or completed requests", async t => {
  const { store, clock, worker } = await setup(t);
  const original = (await store.createRequest(worker.session, body(clock))).request;
  const oldDone = (await store.complete(original.id, { expectedVersion: original.version })).request;
  const newer = (await store.createRequest(worker.session, body(clock))).request;
  assert.equal(newer.createdAt, original.createdAt);
  const reopened = (await store.reopen(oldDone.id, { expectedVersion: oldDone.version })).request;
  assert.equal(reopened.status, "new");
  assert.equal((await store.doctorState()).requests.filter(item => item.status !== "done").length, 2);
  const oldDoneAgain = (await store.complete(reopened.id, { expectedVersion: reopened.version })).request;
  await store.complete(newer.id, { expectedVersion: newer.version });
  assert.equal((await store.reopen(oldDoneAgain.id, { expectedVersion: oldDoneAgain.version })).request.status, "new");
});

test("a concurrent new request and undo both succeed as separate active requests", async t => {
  const { store, clock, worker, db } = await setup(t);
  const original = (await store.createRequest(worker.session, body(clock))).request;
  const done = (await store.complete(original.id, { expectedVersion: original.version })).request;
  const [visit, undo] = await Promise.all([
    store.createRequest(worker.session, body(clock)),
    store.reopen(done.id, { expectedVersion: done.version }),
  ]);
  assert.equal(visit.created, true);
  assert.notEqual(visit.request.id, original.id);
  assert.equal(undo.request.id, original.id);
  assert.equal(undo.request.status, "new");
  const rows = (await db.prepare("SELECT * FROM requests WHERE owner=? AND status!='done'").bind(worker.session.hash).all()).results;
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set([original.id, visit.request.id]));
});

test("concurrent completion undo still allows only one versioned winner", async t => {
  const { store, clock, worker } = await setup(t);
  const original = (await store.createRequest(worker.session, body(clock))).request;
  const done = (await store.complete(original.id, { expectedVersion: original.version })).request;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => store.reopen(done.id, { expectedVersion: done.version })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results.filter(result => result.status === "rejected")) {
    assert.equal(result.reason.status, 409);
    assert.equal(result.reason.code, "VERSION_CONFLICT");
  }
});

test("exact seven-day expiry denies reads and edits before scheduled cleanup removes stored data", async t => {
  const { store, clock, worker, db } = await setup(t);
  const original = (await store.createRequest(worker.session, body(clock, { note: "Geçici örnek" }))).request;
  clock.value += 4 * DAY;
  const later = (await store.createRequest(worker.session, body(clock))).request;
  clock.value = MONDAY_0900_ISTANBUL + RETENTION_MS - 1;
  assert.ok((await store.publicState(worker.session)).requests.some(item => item.id === original.id));
  clock.value += 1;
  assert.deepEqual((await store.publicState(worker.session)).requests.map(item => item.id), [later.id]);
  assert.deepEqual((await store.doctorState()).requests.map(item => item.id), [later.id]);
  await rejects(() => store.answer(original.id, { expectedVersion: original.version, text: "Artık görünmemeli" }), 404, "NOT_FOUND");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM requests WHERE id=?").bind(original.id).first()).count, 1);
  const cleaned = await store.cleanup();
  assert.equal(cleaned.requestsDeleted, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM requests WHERE id=?").bind(original.id).first()).count, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM request_operations WHERE request_id=?").bind(original.id).first()).count, 0);
});

test("a visit one minute before session expiry gets a full new seven-day lifetime", async t => {
  const { store, clock, worker } = await setup(t);
  clock.value = worker.expiresAt - 60_000; // Following Monday 08:59 Istanbul.
  const created = (await store.createRequest(worker.session, body(clock))).request;
  assert.equal(Date.parse(created.expiresAt), clock.value + RETENTION_MS);
  clock.value = worker.expiresAt;
  await store.cleanup();
  assert.ok(await store.session(worker.token));
  assert.equal((await store.publicState(worker.session)).requests[0].id, created.id);
  clock.value = Date.parse(created.expiresAt) - 1;
  assert.equal((await store.doctorState()).requests.length, 1);
  clock.value += 1;
  assert.equal(await store.session(worker.token), null);
  assert.equal((await store.doctorState()).requests.length, 0);
  await rejects(() => store.publicState(worker.session), 401, "SESSION_EXPIRED");
  const cleaned = await store.cleanup();
  assert.equal(cleaned.requestsDeleted, 1);
  assert.equal(cleaned.sessionsDeleted, 1);
});

test("daily overrides and status expire at Istanbul midnight and unrelated edits do not revive them", async t => {
  const { store, clock } = await setup(t);
  const settings = (await store.doctorState()).settings;
  const saved = (await store.updateSettings({
    expectedVersion: settings.version, formDate: settings.formDate,
    todayOverride: { open: false, start: "08:00", end: "17:00", message: "Bugüne özel örnek" },
    statusMessage: "Bugünkü saha turu", returnMinutes: 60,
  })).settings;
  assert.ok(saved.todayOverride);
  assert.ok(saved.returnAt);
  assert.equal((await store.doctorState()).availability.accepting, false);
  clock.value = Date.parse("2026-10-05T20:59:59.999Z");
  assert.ok((await store.doctorState()).settings.todayOverride);
  clock.value += 1;
  const nextDay = (await store.doctorState()).settings;
  assert.equal(nextDay.formDate, "2026-10-06");
  assert.equal(nextDay.todayOverride, null);
  assert.equal(nextDay.statusMessage, "");
  assert.equal(nextDay.returnAt, null);
  await rejects(() => store.updateSettings({ expectedVersion: saved.version, formDate: saved.formDate, statusMessage: "Eski günü uygulama" }), 409, "STALE_FORM");
  const updated = (await store.updateSettings({
    expectedVersion: nextDay.version, formDate: nextDay.formDate, emergencyText: "Örnek acil yardım açıklaması",
  })).settings;
  assert.equal(updated.todayOverride, null);
  assert.equal(updated.statusMessage, "");
  assert.equal(updated.returnAt, null);
  clock.value = Date.parse("2026-10-06T06:00:00Z");
  const final = await store.doctorState();
  assert.equal(final.availability.accepting, true);
  assert.equal(final.availability.statusMessage, "");
});

test("reading or answering never renews the employee session or request retention", async t => {
  const { store, clock, worker, db } = await setup(t);
  const created = (await store.createRequest(worker.session, body(clock))).request;
  clock.value += DAY;
  await store.publicState(worker.session);
  await store.doctorState();
  const answered = (await store.answer(created.id, { expectedVersion: created.version, returnMinutes: 15 })).request;
  assert.equal(answered.reply, "Saat 09:15 civarında revirde olacağım.");
  assert.equal(answered.expiresAt, created.expiresAt);
  assert.equal((await db.prepare("SELECT expires FROM sessions WHERE hash=?").bind(worker.session.hash).first()).expires, worker.expiresAt);
  clock.value += 30 * 60_000;
  assert.equal((await store.publicState(worker.session)).requests[0].reply, answered.reply);
});

test("blank optional details are valid and overlong details are rejected before any insertion", async t => {
  const { store, clock, worker, createWorker, db } = await setup(t);
  const blank = (await store.createRequest(worker.session, body(clock))).request;
  assert.equal(blank.note, "");
  assert.equal(blank.phone, "");
  assert.equal(blank.fullName, "");
  const other = await createWorker();
  for (const extra of [{ note: "x".repeat(301) }, { fullName: "x".repeat(81) }, { phone: "12" }]) {
    await assert.rejects(() => store.createRequest(other.session, body(clock, extra)), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 400);
      return true;
    });
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM requests").first()).count, 1);
});
