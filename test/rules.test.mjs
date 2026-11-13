import test from "node:test";
import assert from "node:assert/strict";
import { AppError, availability, defaultSettings, nextSettings, visibleSettings } from "../src/rules.mjs";

const DATE = "2026-10-05";
const at = time => Date.parse(`${DATE}T${time}:00+03:00`);
const edit = (settings, extra) => ({ expectedVersion: settings.version, formDate: DATE, ...extra });

test("legacy settings without pauseDate remain available and expose only the derived pause state", () => {
  const legacy = defaultSettings();
  delete legacy.pauseDate;
  const state = visibleSettings(legacy, at("09:00"));
  assert.equal(state.pausedToday, false);
  assert.equal("pauseDate" in state, false);
  assert.equal(availability(legacy, at("09:00")).accepting, true);
  assert.equal(availability(legacy, at("09:00")).pausedToday, false);
});

test("before-start, open and ended working hours use accurate availability wording", () => {
  const settings = defaultSettings();
  settings.todayOverride = { date: DATE, open: true, start: "15:00", end: "17:33", message: "İstasyondayım" };
  assert.equal(availability(settings, at("14:36")).detail, "Bugün 15:00–17:33 arasında talep kabul edilecek.");
  assert.equal(availability(settings, at("14:36")).accepting, false);
  assert.equal(availability(settings, at("15:00")).accepting, true);
  assert.equal(availability(settings, at("17:33")).detail, "Bugünkü talep kabul saati sona erdi.");
  assert.equal(availability(settings, at("17:33")).accepting, false);
});

test("daily pause preserves weekly hours, today's custom hours, physician note and return time", () => {
  const initial = defaultSettings();
  const settings = nextSettings(initial, edit(initial, {
    todayOverride: { open: true, start: "10:00", end: "16:30", message: "İstasyondayım" },
    statusMessage: "Saha çalışmasındayım", returnMinutes: 60,
  }), at("11:00"));
  const paused = nextSettings(settings, edit(settings, { pauseToday: true }), at("11:01"));
  assert.equal(paused.pauseDate, DATE);
  assert.deepEqual(paused.schedule, settings.schedule);
  assert.deepEqual(paused.todayOverride, settings.todayOverride);
  assert.equal(paused.statusMessage, settings.statusMessage);
  assert.equal(paused.returnAt, settings.returnAt);
  assert.equal(visibleSettings(paused, at("11:01")).pausedToday, true);
  assert.deepEqual(availability(paused, at("11:01")), {
    accepting: false, pausedToday: true, headline: "Revir talep kabul etmiyor",
    detail: "Bugün talep alımı hekim tarafından kapatıldı.",
    statusMessage: "İstasyondayım", returnAt: new Date(settings.returnAt).toISOString(),
  });
  const noteUpdated = nextSettings(paused, edit(paused, { statusMessage: "Başka istasyondayım" }), at("11:02"));
  assert.equal(noteUpdated.pauseDate, DATE);
  const resumed = nextSettings(noteUpdated, edit(noteUpdated, { pauseToday: false }), at("11:03"));
  assert.equal(resumed.pauseDate, null);
  assert.deepEqual(resumed.todayOverride, settings.todayOverride);
  assert.equal(availability(resumed, at("11:03")).accepting, true);
});

test("resuming daily pause obeys the existing schedule before, during, after and on closed days", () => {
  for (const [time, open, accepting, detail] of [
    ["07:59", true, false, "Bugün 08:00–17:00 arasında talep kabul edilecek."],
    ["08:00", true, true, "Bugün 17:00 saatine kadar haber verebilirsiniz."],
    ["17:00", true, false, "Bugünkü talep kabul saati sona erdi."],
    ["09:00", false, false, "Bugün talep kabul edilmiyor."],
  ]) {
    const initial = defaultSettings();
    initial.schedule[1].open = open;
    const paused = nextSettings(initial, edit(initial, { pauseToday: true }), at(time));
    assert.equal(availability(paused, at(time)).accepting, false);
    const resumed = nextSettings(paused, edit(paused, { pauseToday: false }), at(time));
    assert.deepEqual(resumed.schedule, initial.schedule);
    assert.equal(availability(resumed, at(time)).accepting, accepting);
    assert.equal(availability(resumed, at(time)).detail, detail);
  }
});

test("daily pause expires at Istanbul midnight and unrelated edits cannot revive it", () => {
  const settings = { ...defaultSettings(), pauseDate: DATE };
  assert.equal(visibleSettings(settings, Date.parse("2026-10-05T20:59:59.999Z")).pausedToday, true);
  const midnight = Date.parse("2026-10-05T21:00:00Z");
  assert.equal(visibleSettings(settings, midnight).formDate, "2026-10-06");
  assert.equal(visibleSettings(settings, midnight).pausedToday, false);
  assert.equal(availability(settings, Date.parse("2026-10-06T06:00:00Z")).accepting, true);
  const updated = nextSettings(settings, { expectedVersion: settings.version, emergencyText: "Acil hat" }, midnight);
  assert.equal(updated.pauseDate, null);
});

test("daily pause rejects a missing/stale form date, stale version and nonboolean value", () => {
  const settings = defaultSettings();
  for (const body of [
    { expectedVersion: 1, pauseToday: true },
    { expectedVersion: 1, pauseToday: false, formDate: "2026-10-04" },
  ]) assert.throws(() => nextSettings(settings, body, at("09:00")), error => error instanceof AppError && error.code === "STALE_FORM");
  assert.throws(() => nextSettings(settings, edit(settings, { pauseToday: true, expectedVersion: 0 }), at("09:00")), error => error instanceof AppError && error.code === "VERSION_CONFLICT");
  for (const pauseToday of [null, "true", "false", 1, 0]) {
    assert.throws(() => nextSettings(settings, edit(settings, { pauseToday }), at("09:00")), error => error instanceof AppError && error.code === "INVALID_FIELD");
  }
});
