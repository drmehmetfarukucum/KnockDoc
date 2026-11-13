export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

const localFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function localTime(now) {
  const parts = Object.fromEntries(localFormatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}

export function iso(now) { return new Date(now).toISOString(); }

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function textField(value, limit, label) {
  if (typeof value !== "string") throw new AppError(400, "INVALID_FIELD", `${label} metin olmalı.`);
  value = value.trim();
  if ([...value].length > limit) throw new AppError(400, "INVALID_FIELD", `${label} en fazla ${limit} karakter olabilir.`);
  if (/[\u0000-\u0008\u000b-\u001f]/.test(value)) throw new AppError(400, "INVALID_FIELD", `${label} geçersiz karakter içeriyor.`);
  return value;
}

export function phoneField(value) {
  value = textField(value, 30, "Telefon");
  const digits = value.replace(/\D/g, "");
  if (value && (!/^[+0-9() .-]+$/.test(value) || digits.length < 3 || digits.length > 15)) {
    throw new AppError(400, "INVALID_PHONE", "Telefon numarasını kontrol edin.");
  }
  return value;
}

export function validateHours(value) {
  if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.open !== "boolean") {
    throw new AppError(400, "INVALID_HOURS", "Açık/kapalı seçimini kontrol edin.");
  }
  const start = Object.hasOwn(value, "start") ? value.start : "08:00";
  const end = Object.hasOwn(value, "end") ? value.end : "17:00";
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof start !== "string" || typeof end !== "string" || !time.test(start) || !time.test(end)) {
    throw new AppError(400, "INVALID_HOURS", "Saatleri SS:DD biçiminde girin.");
  }
  if (value.open && start >= end) throw new AppError(400, "INVALID_HOURS", "Bitiş saati başlangıçtan sonra olmalı.");
  return { open: value.open, start, end };
}

export function defaultSettings() {
  return {
    version: 1,
    schedule: Array.from({ length: 7 }, (_, day) => ({ open: [1, 2, 4, 5].includes(day), start: "08:00", end: "17:00" })),
    todayOverride: null, pauseDate: null, statusDate: null, statusMessage: "", returnAt: null,
    workPhone: "", emergencyText: "",
  };
}

export function visibleSettings(settings, now) {
  const date = localTime(now).date;
  const result = { ...settings, formDate: date, pausedToday: settings.pauseDate === date };
  if (!result.todayOverride || result.todayOverride.date !== date || !validDate(result.todayOverride.date)) result.todayOverride = null;
  if (result.statusDate !== date) {
    result.statusMessage = "";
    result.returnAt = null;
  } else if (!Number.isFinite(result.returnAt) || result.returnAt <= now) result.returnAt = null;
  if (result.returnAt !== null) result.returnAt = iso(result.returnAt);
  delete result.statusDate;
  delete result.pauseDate;
  return result;
}

export function availability(settings, now) {
  const local = localTime(now);
  const visible = visibleSettings(settings, now);
  const hours = visible.todayOverride || settings.schedule[local.weekday];
  const accepting = !visible.pausedToday && hours.open && hours.start <= local.time && local.time < hours.end;
  let detail;
  if (visible.pausedToday) detail = "Bugün talep alımı hekim tarafından kapatıldı.";
  else if (!hours.open) detail = "Bugün talep kabul edilmiyor.";
  else if (local.time < hours.start) detail = `Bugün ${hours.start}–${hours.end} arasında talep kabul edilecek.`;
  else if (local.time >= hours.end) detail = "Bugünkü talep kabul saati sona erdi.";
  else detail = `Bugün ${hours.end} saatine kadar haber verebilirsiniz.`;
  return {
    accepting, pausedToday: visible.pausedToday,
    headline: accepting ? "Revir talep kabul ediyor" : "Revir talep kabul etmiyor",
    detail, statusMessage: hours.message || visible.statusMessage, returnAt: visible.returnAt,
  };
}

export function minutesField(value) {
  if (value !== null && (!Number.isInteger(value) || ![15, 30, 60].includes(value))) {
    throw new AppError(400, "INVALID_MINUTES", "Süreyi kontrol edin.");
  }
  return value;
}

export function expectedVersion(version, body) {
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== version) throw versionConflict();
}

export function versionConflict() {
  return new AppError(409, "VERSION_CONFLICT", "Bu kayıt başka bir işlemle değişti. Yazdıklarınız korunuyor; güncel kaydı yükleyip yeniden deneyin.");
}

export function requestFields(body) {
  return {
    note: textField(Object.hasOwn(body, "note") ? body.note : "", 300, "Not"),
    phone: phoneField(Object.hasOwn(body, "phone") ? body.phone : ""),
    fullName: textField(Object.hasOwn(body, "fullName") ? body.fullName : "", 80, "İsim soyisim"),
  };
}

export function operationId(body) {
  if (typeof body.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.operationId)) {
    throw new AppError(400, "INVALID_OPERATION", "Sayfayı yenileyip yeniden deneyin.");
  }
  return body.operationId;
}

export function nextSettings(settings, body, now) {
  expectedVersion(settings.version, body);
  const date = localTime(now).date;
  const dailyEdit = ["todayOverride", "pauseToday", "statusMessage", "returnMinutes"].some(key => Object.hasOwn(body, key));
  if ((Object.hasOwn(body, "formDate") || dailyEdit) && (!validDate(body.formDate) || body.formDate !== date)) {
    throw new AppError(409, "STALE_FORM", "Gün değişti. Güncel bugüne özel ayarı yükleyip yeniden kaydedin.");
  }
  if (Object.hasOwn(body, "pauseToday") && typeof body.pauseToday !== "boolean") {
    throw new AppError(400, "INVALID_FIELD", "Bugünkü talep alımı açık veya kapalı olmalı.");
  }
  const sourceSchedule = Object.hasOwn(body, "schedule") ? body.schedule : settings.schedule;
  if (!Array.isArray(sourceSchedule) || sourceSchedule.length !== 7) throw new AppError(400, "INVALID_SCHEDULE", "Haftanın yedi gününü kontrol edin.");
  const schedule = sourceSchedule.map(validateHours);
  const currentOverride = settings.todayOverride?.date === date && validDate(settings.todayOverride.date) ? settings.todayOverride : null;
  let override = Object.hasOwn(body, "todayOverride") ? body.todayOverride : currentOverride;
  if (override !== null) {
    const hours = validateHours(override);
    if (Object.hasOwn(override, "date") && (!validDate(override.date) || override.date !== date)) {
      throw new AppError(409, "STALE_FORM", "Bugüne özel ayarın tarihini kontrol edin; güncel ayarları yükleyin.");
    }
    override = { ...hours, date, message: textField(Object.hasOwn(override, "message") ? override.message : "", 160, "Bugünkü açıklama") };
  }
  let returnAt = settings.statusDate === date && Number.isFinite(settings.returnAt) && settings.returnAt > now ? settings.returnAt : null;
  if (Object.hasOwn(body, "returnMinutes")) {
    const minutes = minutesField(body.returnMinutes);
    returnAt = minutes === null ? null : now + minutes * 60_000;
  }
  return {
    version: settings.version + 1, schedule, todayOverride: override,
    pauseDate: Object.hasOwn(body, "pauseToday") ? (body.pauseToday ? date : null) : (settings.pauseDate === date ? date : null),
    statusDate: date,
    statusMessage: textField(Object.hasOwn(body, "statusMessage") ? body.statusMessage : (settings.statusDate === date ? settings.statusMessage : ""), 160, "Genel durum"),
    returnAt, workPhone: phoneField(Object.hasOwn(body, "workPhone") ? body.workPhone : settings.workPhone),
    emergencyText: textField(Object.hasOwn(body, "emergencyText") ? body.emergencyText : settings.emergencyText, 200, "Acil iletişim açıklaması"),
  };
}

export function record(row) {
  const visitorNumber = Number.isSafeInteger(row.visitor_number) && row.visitor_number >= 1 ? row.visitor_number : null;
  const visitorDay = validDate(row.created_day) ? row.created_day : null;
  const weekday = visitorDay ? new Date(`${visitorDay}T12:00:00Z`).getUTCDay() : null;
  return {
    id: row.id, createdAt: iso(row.created), expiresAt: iso(row.expires), status: row.status,
    visitorNumber, visitorDay,
    visitorCode: visitorNumber && visitorDay ? `${["Pzr", "Pzt", "Salı", "Çarş", "Perş", "Cuma", "Cmt"][weekday]}-${visitorNumber}` : null,
    note: row.note, phone: row.phone, fullName: row.full_name, reply: row.reply,
    repliedAt: row.replied === null ? null : iso(row.replied),
    presence: row.presence ?? null,
    presenceUpdatedAt: row.presence_updated == null ? null : iso(row.presence_updated),
    replyVersion: row.reply_version ?? 0,
    messageVersion: row.message_version ?? 0,
    latestMessageAt: row.latest_message_at == null ? null : iso(row.latest_message_at),
    completedAt: row.completed === null ? null : iso(row.completed), version: row.version,
  };
}
