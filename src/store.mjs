import {
  AppError, RETENTION_MS, localTime, iso, visibleSettings, availability, requestFields,
  operationId, nextSettings, expectedVersion, versionConflict, minutesField, textField, phoneField, record,
} from "./rules.mjs";

async function tokenHash(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const notFound = () => new AppError(404, "NOT_FOUND", "Talep bulunamadı veya yedi günlük süresi sona erdi.");
const sessionExpired = () => new AppError(401, "SESSION_EXPIRED", "Sayfayı yenileyin; oturumunuz sona erdi.");
const alreadyDone = () => new AppError(409, "ALREADY_DONE", "Yanıtlamak için önce tamamlamayı geri alın.");

export class Store {
  constructor(db, clock = () => Date.now()) { this.db = db; this.clock = clock; }

  statement(sql, ...parameters) { return this.db.prepare(sql).bind(...parameters); }
  async first(sql, ...parameters) { return this.statement(sql, ...parameters).first(); }
  async all(sql, ...parameters) { return (await this.statement(sql, ...parameters).all()).results; }
  async recordsWithMessages(rows) {
    const grouped = new Map(rows.map(row => [row.id, []]));
    // Batch by D1's parameter limit rather than issuing one read per request.
    for (let start = 0; start < rows.length; start += 80) {
      const ids = rows.slice(start, start + 80).map(row => row.id);
      const messages = await this.all(`SELECT id,request_id,text,full_name,phone,created
        FROM request_messages WHERE request_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`, ...ids);
      for (const message of messages) grouped.get(message.request_id)?.push({
        id: message.id, text: message.text, fullName: message.full_name,
        phone: message.phone, createdAt: iso(message.created),
      });
    }
    return rows.map(row => ({ ...record(row), messages: grouped.get(row.id) }));
  }

  async recordWithMessages(row) { return (await this.recordsWithMessages([row]))[0]; }

  async settings() {
    const row = await this.first("SELECT value FROM config WHERE id=1");
    if (!row) throw new AppError(503, "NOT_CONFIGURED", "Uygulamanın kurulumu henüz tamamlanmadı.");
    return JSON.parse(row.value);
  }

  async createSession() {
    const token = randomToken();
    const csrf = randomToken();
    const expiresAt = this.clock() + RETENTION_MS;
    await this.statement("INSERT INTO sessions(hash,csrf,expires) VALUES(?,?,?)", await tokenHash(token), csrf, expiresAt).run();
    return { token, csrf, expiresAt };
  }

  async session(token) {
    if (typeof token !== "string" || token.length > 100 || !token) return null;
    return await this.first("SELECT hash,csrf,expires FROM sessions WHERE hash=? AND expires>?", await tokenHash(token), this.clock());
  }

  async workerCheck(session, now) {
    if (!session || typeof session.hash !== "string") throw sessionExpired();
    if (!await this.first("SELECT hash FROM sessions WHERE hash=? AND expires>?", session.hash, now)) throw sessionExpired();
  }

  async publicState(session) {
    const now = this.clock();
    await this.workerCheck(session, now);
    const [settings, rows] = await Promise.all([
      this.settings(), this.all("SELECT * FROM requests WHERE owner=? AND expires>? ORDER BY seq DESC", session.hash, now),
    ]);
    const date = localTime(now).date;
    return {
      serverTime: iso(now), csrfToken: session.csrf, formDate: date,
      availability: availability(settings, now), schedule: settings.schedule,
      contacts: { workPhone: settings.workPhone, emergencyText: settings.emergencyText },
      requests: await this.recordsWithMessages(rows), activeRequestId: rows.find(row => row.status !== "done" && row.created_day === date)?.id ?? null,
    };
  }

  async doctorState() {
    const now = this.clock();
    const [settings, rows] = await Promise.all([this.settings(), this.all("SELECT * FROM requests WHERE expires>? ORDER BY seq DESC", now)]);
    return {
      serverTime: iso(now), availability: availability(settings, now), schedule: settings.schedule,
      settings: visibleSettings(settings, now), requests: await this.recordsWithMessages(rows),
    };
  }

  async cleanup() {
    const now = this.clock();
    const results = await this.db.batch([
      this.statement("SELECT COUNT(*) AS count FROM requests WHERE expires<=?", now),
      this.statement("DELETE FROM requests WHERE expires<=?", now),
      this.statement("SELECT COUNT(*) AS count FROM sessions WHERE expires<=?", now),
      this.statement("DELETE FROM sessions WHERE expires<=?", now),
      this.statement("DELETE FROM daily_visitors WHERE expires<=?", now),
      this.statement("DELETE FROM daily_visitor_counters WHERE day<?", localTime(now - 8 * 24 * 60 * 60 * 1000).date),
      this.statement("DELETE FROM app_feedback WHERE expires<=?", now),
    ]);
    // D1's changes count includes cascaded operation aliases. Count logical
    // records inside the same transaction so cleanup reports requests accurately.
    return { requestsDeleted: results[0].results[0].count, sessionsDeleted: results[2].results[0].count };
  }

  async mappedRequest(owner, operation, now) {
    return this.first("SELECT requests.* FROM request_operations JOIN requests ON requests.id=request_operations.request_id WHERE request_operations.owner=? AND request_operations.operation_id=? AND requests.expires>?", owner, operation, now);
  }

  async createRequest(session, body) {
    const operation = operationId(body);
    const now = this.clock();
    await this.workerCheck(session, now);
    const previous = await this.mappedRequest(session.hash, operation, now);
    if (previous) return { request: await this.recordWithMessages(previous), created: false, message: "Bu gönderim daha önce kaydedildi; aynı talep gösteriliyor." };
    const date = localTime(now).date;
    if (body.formDate !== date) throw new AppError(409, "STALE_FORM", "Gün değişti. Sayfayı yenileyip yeni gelişinizi bildirin.");
    const fields = requestFields(body);
    const id = crypto.randomUUID();
    const expires = now + RETENTION_MS;
    // A D1 batch is a transaction. Every insertion checks the current settings
    // version, session and existing operation within that transaction. Map an
    // operation only to this insertion's id, never to another open request.
    for (let attempt = 0; attempt < 3; attempt++) {
      const settings = await this.settings();
      if (!availability(settings, now).accepting) {
        const retried = await this.mappedRequest(session.hash, operation, now);
        if (retried) return { request: await this.recordWithMessages(retried), created: false, message: "Bu gönderim daha önce kaydedildi; aynı talep gösteriliyor." };
        throw new AppError(409, "CLOSED", "Şu anda yeni talep kabul edilmiyor. Güncel durumu kontrol edin.");
      }
      const results = await this.db.batch([
        this.statement("DELETE FROM requests WHERE expires<=?", now),
        this.statement(`INSERT OR IGNORE INTO requests(id,owner,created_day,created,expires,status,note,phone,full_name)
          SELECT ?,?,?,?,?,'new',?,?,? WHERE
          EXISTS(SELECT 1 FROM config WHERE id=1 AND json_extract(value,'$.version')=?)
          AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)
          AND NOT EXISTS(SELECT 1 FROM request_operations WHERE owner=? AND operation_id=?)`,
        id, session.hash, date, now, expires, fields.note, fields.phone, fields.fullName,
        settings.version, session.hash, now, session.hash, operation),
        // Each batch is serialized by D1. Allocate a number only for this batch's
        // newly inserted request and only once for its owner/day. Retries and
        // rejected inserts cannot consume a number or renew alias retention.
        this.statement(`INSERT OR IGNORE INTO daily_visitor_counters(day,last_number)
          SELECT ?,0 WHERE EXISTS(SELECT 1 FROM requests WHERE id=? AND owner=? AND visitor_number IS NULL)`,
        date, id, session.hash),
        this.statement(`UPDATE daily_visitor_counters SET last_number=last_number+1
          WHERE day=? AND EXISTS(SELECT 1 FROM requests WHERE id=? AND owner=? AND visitor_number IS NULL)
          AND NOT EXISTS(SELECT 1 FROM daily_visitors WHERE day=? AND owner=?)`,
        date, id, session.hash, date, session.hash),
        this.statement(`INSERT INTO daily_visitors(day,owner,number,expires)
          SELECT requests.created_day,requests.owner,COALESCE((
            SELECT number FROM daily_visitors WHERE day=requests.created_day AND owner=requests.owner
          ),daily_visitor_counters.last_number),requests.expires
          FROM requests JOIN daily_visitor_counters ON daily_visitor_counters.day=requests.created_day
          WHERE requests.id=? AND requests.owner=? AND requests.visitor_number IS NULL
          ON CONFLICT(day,owner) DO UPDATE SET expires=MAX(daily_visitors.expires,excluded.expires)`,
        id, session.hash),
        this.statement(`UPDATE requests SET visitor_number=(
          SELECT number FROM daily_visitors WHERE day=requests.created_day AND owner=requests.owner)
          WHERE id=? AND owner=? AND visitor_number IS NULL`, id, session.hash),
        this.statement(`INSERT OR IGNORE INTO request_operations(owner,operation_id,request_id)
          SELECT ?,?,id FROM requests WHERE id=? AND owner=? AND expires>?`,
        session.hash, operation, id, session.hash, now),
        this.statement("UPDATE sessions SET expires=MAX(expires,?) WHERE hash=? AND EXISTS(SELECT 1 FROM requests WHERE id=? AND owner=?)", expires, session.hash, id, session.hash),
        this.statement("SELECT requests.* FROM request_operations JOIN requests ON requests.id=request_operations.request_id WHERE request_operations.owner=? AND request_operations.operation_id=? AND requests.expires>?", session.hash, operation, now),
      ]);
      const row = results[8].results[0];
      if (row) {
        const created = results[1].meta.changes === 1;
        return {
          request: await this.recordWithMessages(row), created,
          message: created ? "Talebiniz alındı. Hekimin yanıtı bu sayfada görünecek." : "Bu gönderim daha önce kaydedildi; aynı talep gösteriliyor.",
        };
      }
      await this.workerCheck(session, now);
    }
    throw versionConflict();
  }

  async updateSettings(body) {
    const now = this.clock();
    const current = await this.settings();
    const updated = nextSettings(current, body, now);
    const results = await this.db.batch([
      this.statement("UPDATE config SET value=? WHERE id=1 AND json_extract(value,'$.version')=?", JSON.stringify(updated), current.version),
      this.statement("SELECT value FROM config WHERE id=1"),
    ]);
    if (results[0].meta.changes !== 1) throw versionConflict();
    return { settings: visibleSettings(JSON.parse(results[1].results[0].value), now) };
  }

  async request(id, now) {
    const row = await this.first("SELECT * FROM requests WHERE id=? AND expires>?", id, now);
    if (!row) throw notFound();
    return row;
  }

  async answer(id, body) {
    const now = this.clock();
    const current = await this.request(id, now);
    expectedVersion(current.version, body);
    if (current.status === "done") throw alreadyDone();
    const minutes = minutesField(body.returnMinutes ?? null);
    const reply = minutes === null ? textField(Object.hasOwn(body, "text") ? body.text : "", 300, "Yanıt") : `Saat ${localTime(now + minutes * 60_000).time} civarında revirde olacağım.`;
    if (!reply) throw new AppError(400, "EMPTY_REPLY", "Kısa bir yanıt yazın veya hazır yanıt seçin.");
    const results = await this.db.batch([
      this.statement("UPDATE requests SET status='answered',reply=?,replied=?,presence=NULL,presence_updated=NULL,reply_version=version+1,version=version+1 WHERE id=? AND version=? AND status!='done' AND expires>?", reply, now, id, current.version, now),
      this.statement("SELECT * FROM requests WHERE id=? AND expires>?", id, now),
    ]);
    const row = results[1].results[0];
    if (!row) throw notFound();
    if (results[0].meta.changes !== 1) throw versionConflict();
    return { request: await this.recordWithMessages(row) };
  }

  async updatePresence(session, id, body) {
    const now = this.clock();
    await this.workerCheck(session, now);
    if (!['waiting', 'left'].includes(body.presence)) {
      throw new AppError(400, 'INVALID_PRESENCE', 'Bekleme durumunuzu iki seçenekten biriyle belirtin.');
    }
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 ||
        !Number.isSafeInteger(body.expectedReplyVersion) || body.expectedReplyVersion < 1) throw versionConflict();

    const readOwned = () => this.first(`SELECT requests.* FROM requests
      WHERE id=? AND owner=? AND expires>?
      AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)`, id, session.hash, now, session.hash, now);
    const checkReply = row => {
      if (!row) throw notFound();
      if (row.status !== 'answered' || !row.reply || row.replied === null) {
        throw new AppError(409, 'PRESENCE_UNAVAILABLE', 'Bekleme durumu yalnızca hekim yanıtı olan açık bir talepte değiştirilebilir.');
      }
      // A response to an earlier physician answer must never confirm the new one,
      // even if the employee chose the same value previously.
      if (row.reply_version !== body.expectedReplyVersion) throw versionConflict();
    };
    const current = await readOwned();
    checkReply(current);
    if (current.presence === body.presence) return { request: await this.recordWithMessages(current), changed: false };
    expectedVersion(current.version, body);

    // The update and read share one D1 transaction. Ownership, a live session,
    // the precise physician answer and the record version are checked again at
    // the write boundary so completion, a new answer or another tap cannot race.
    const results = await this.db.batch([
      this.statement(`UPDATE requests SET presence=?,presence_updated=?,version=version+1
        WHERE id=? AND owner=? AND version=? AND reply_version=?
        AND status='answered' AND reply<>'' AND replied IS NOT NULL AND expires>?
        AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)`,
      body.presence, now, id, session.hash, current.version, body.expectedReplyVersion, now, session.hash, now),
      this.statement(`SELECT requests.* FROM requests
        WHERE id=? AND owner=? AND expires>?
        AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)`, id, session.hash, now, session.hash, now),
    ]);
    const row = results[1].results[0];
    if (results[0].meta.changes !== 1) {
      await this.workerCheck(session, now);
      checkReply(row);
      // Lost-response retries and simultaneous identical taps are acknowledgments
      // of the saved choice, not new changes or new notifications.
      if (row.presence === body.presence) return { request: await this.recordWithMessages(row), changed: false };
      throw versionConflict();
    }
    return { request: await this.recordWithMessages(row), changed: true };
  }

  async addRequestMessage(session, id, body) {
    const operation = operationId(body);
    const now = this.clock();
    await this.workerCheck(session, now);
    const readOwned = () => this.first(`SELECT requests.* FROM requests
      WHERE id=? AND owner=? AND expires>?
      AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)`, id, session.hash, now, session.hash, now);
    const previousMessage = () => this.first("SELECT id FROM request_messages WHERE request_id=? AND operation_id=?", id, operation);
    let current = await readOwned();
    if (!current) throw notFound();
    if (await previousMessage()) return { request: await this.recordWithMessages(current), created: false };
    const text = textField(Object.hasOwn(body, "text") ? body.text : "", 300, "Not");
    const fullName = textField(Object.hasOwn(body, "fullName") ? body.fullName : "", 80, "İsim soyisim");
    const phone = phoneField(Object.hasOwn(body, "phone") ? body.phone : "");
    if (!text && !fullName && !phone) throw new AppError(400, "EMPTY_MESSAGE", "Kısa bir not veya iletişim bilgisi yazın.");
    const messageId = crypto.randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (current.status === "done") throw new AppError(409, "MESSAGE_UNAVAILABLE", "Bu talep tamamlandı. Tekrar geldiğinizde yeni gelişinizi bildirin.");
      const results = await this.db.batch([
        this.statement(`INSERT OR IGNORE INTO request_messages(id,request_id,operation_id,text,full_name,phone,created)
          SELECT ?,id,?,?,?,?,? FROM requests WHERE id=? AND owner=? AND version=?
          AND status IN ('new','answered') AND expires>?
          AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)
          AND (SELECT COUNT(*) FROM request_messages WHERE request_id=requests.id)<20
          AND NOT EXISTS(SELECT 1 FROM request_messages WHERE request_id=requests.id AND operation_id=?)`,
        messageId, operation, text, fullName, phone, now, id, session.hash, current.version, now, session.hash, now, operation),
        this.statement(`UPDATE requests SET full_name=CASE WHEN ?<>'' THEN ? ELSE full_name END,
          phone=CASE WHEN ?<>'' THEN ? ELSE phone END,message_version=message_version+1,
          latest_message_at=?,version=version+1 WHERE id=? AND owner=? AND version=?
          AND status IN ('new','answered') AND expires>?
          AND EXISTS(SELECT 1 FROM request_messages WHERE id=? AND request_id=requests.id)`,
        fullName, fullName, phone, phone, now, id, session.hash, current.version, now, messageId),
        this.statement(`SELECT requests.* FROM requests WHERE id=? AND owner=? AND expires>?
          AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)`, id, session.hash, now, session.hash, now),
        this.statement("SELECT id FROM request_messages WHERE request_id=? AND operation_id=?", id, operation),
        this.statement("SELECT COUNT(*) AS count FROM request_messages WHERE request_id=?", id),
      ]);
      const row = results[2].results[0];
      if (row && results[3].results[0]) return { request: await this.recordWithMessages(row), created: results[0].meta.changes === 1 };
      await this.workerCheck(session, now);
      if (!row) throw notFound();
      if (row.status === "done") throw new AppError(409, "MESSAGE_UNAVAILABLE", "Bu talep tamamlandı. Tekrar geldiğinizde yeni gelişinizi bildirin.");
      if (results[4].results[0].count >= 20) throw new AppError(429, "MESSAGE_LIMIT", "Bu talebe yeterince not eklendi. Gerekirse revirde hekimle görüşün.");
      current = row;
    }
    throw versionConflict();
  }

  async addFeedback(session, body) {
    const operation = operationId(body);
    const now = this.clock();
    await this.workerCheck(session, now);
    const previous = await this.first("SELECT id FROM app_feedback WHERE owner=? AND operation_id=? AND expires>?", session.hash, operation, now);
    if (previous) return { ok: true, created: false };
    const text = textField(Object.hasOwn(body, "text") ? body.text : "", 500, "Görüş");
    if (!text) throw new AppError(400, "EMPTY_FEEDBACK", "Uygulama hakkındaki görüşünüzü yazın.");
    if (!["suggestion", "bug", "other"].includes(body.category)) throw new AppError(400, "INVALID_CATEGORY", "Görüş türünü seçin.");
    const id = crypto.randomUUID();
    const results = await this.db.batch([
      this.statement("DELETE FROM app_feedback WHERE expires<=?", now),
      this.statement(`INSERT OR IGNORE INTO app_feedback(id,owner,operation_id,category,text,created,expires)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)
        AND (SELECT COUNT(*) FROM app_feedback WHERE owner=?)<5
        AND NOT EXISTS(SELECT 1 FROM app_feedback WHERE owner=? AND operation_id=?)`,
      id, session.hash, operation, body.category, text, now, now + RETENTION_MS, session.hash, now, session.hash, session.hash, operation),
      this.statement("SELECT id FROM app_feedback WHERE owner=? AND operation_id=? AND expires>?", session.hash, operation, now),
    ]);
    if (results[2].results[0]) return { ok: true, created: results[1].meta.changes === 1 };
    await this.workerCheck(session, now);
    throw new AppError(429, "FEEDBACK_LIMIT", "Görüşünüz alındıysa yeniden göndermenize gerek yok. Bu hafta için yeterince görüş iletildi.");
  }

  async feedback() {
    const rows = await this.all("SELECT id,category,text,created FROM app_feedback WHERE expires>? ORDER BY seq DESC LIMIT 250", this.clock());
    return { feedback: rows.map(row => ({ id: row.id, category: row.category, text: row.text, createdAt: iso(row.created) })) };
  }

  async complete(id, body) {
    const now = this.clock();
    const current = await this.request(id, now);
    if (current.status === "done") return { request: await this.recordWithMessages(current) };
    expectedVersion(current.version, body);
    const results = await this.db.batch([
      this.statement("UPDATE requests SET completed_from=status,status='done',completed=?,version=version+1 WHERE id=? AND version=? AND status!='done' AND expires>?", now, id, current.version, now),
      this.statement("SELECT * FROM requests WHERE id=? AND expires>?", id, now),
    ]);
    const row = results[1].results[0];
    if (!row) throw notFound();
    if (results[0].meta.changes !== 1 && row.status !== "done") throw versionConflict();
    return { request: await this.recordWithMessages(row) };
  }

  async reopen(id, body) {
    const now = this.clock();
    const current = await this.request(id, now);
    expectedVersion(current.version, body);
    if (current.status !== "done") throw new AppError(409, "NOT_DONE", "Talep zaten açık.");
    const previous = ["new", "answered"].includes(current.completed_from) ? current.completed_from : (current.reply ? "answered" : "new");
    const results = await this.db.batch([
      this.statement(`UPDATE requests SET status=?,completed=NULL,completed_from=NULL,version=version+1
        WHERE id=? AND version=? AND status='done' AND expires>?`,
      previous, id, current.version, now),
      this.statement("SELECT * FROM requests WHERE id=? AND expires>?", id, now),
    ]);
    const row = results[1].results[0];
    if (!row) throw notFound();
    if (results[0].meta.changes !== 1) {
      if (row.version !== current.version) throw versionConflict();
      if (row.status !== "done") throw new AppError(409, "NOT_DONE", "Talep zaten açık.");
      throw versionConflict();
    }
    return { request: await this.recordWithMessages(row) };
  }
}
