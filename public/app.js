"use strict";

const isDoctor = location.pathname.startsWith("/doktor");
const app = document.querySelector("#app");
const connection = document.querySelector("#connection");
const days = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
const statuses = { new: "Yeni", answered: "Yanıtlandı", done: "Tamamlandı" };
const operationStorageKey = "revir-request-operation-cloud-v1";
const workerSeenStorageKey = "revir-worker-seen-replies-v1";
const officialContact = Object.freeze({
  name: "Dr. Örnek Hekim",
  phone: "0500 000 00 00",
  dial: "+905000000000",
  email: "hekim@ornek-kurum.example"
});
let publicState = null;
let doctorState = null;
let doctorCsrf = "";
let doctorEmail = "";
let authenticated = false;
let workerMounted = false;
let doctorMounted = false;
let loginMounted = false;
let doctorSessionPromise = null;
let publicReadPromise = null;
let doctorReadPromise = null;
let publicEpoch = 0;
let doctorEpoch = 0;
let lastSuccess = null;
let connectionError = "";
let filter = "new";
let settingsDirty = false;
let settingsVersion = null;
let settingsDate = null;
let settingsVisibleKey = "";
let settingsConflict = false;
let requestsFingerprint = "";
let operation = null;
let requestReadyAt = 0;
let requestCooldownTimer = null;
let workerFormOpen = false;
let workerRetryPending = false;
let workerSelectedRequestId = "";
let workerSeenLoaded = false;
const workerReplyVersions = new Map();
const workerSeenReplies = new Map();
const workerSeenFallback = new Map();
const workerPresenceSaves = new Map();
const workerMessageDrafts = new Map();
const workerMessageSaves = new Map();
let workerMessageTargetId = "";
let workerFeedbackOperation = null;
let doctorFeedbackLoading = false;
let doctorFeedbackHashHandled = false;
let doctorPauseBusy = false;
let doctorPauseMessage = "";
let doctorPauseTone = "success";
let doctorPauseNoticeDate = "";
let doctorPauseNoticeState = null;
let pushGeneration = 0;
let pushRegistrationPromise = null;
let pushLoadPromise = null;
let pushRenewedEndpoint = "";
let pushState = { loaded: false, configured: false, publicKey: "", subscription: null, busy: false, message: "", tone: "error" };
const drafts = new Map();
const busyRequests = new Set();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function dateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(value, options = {}) {
  const date = dateValue(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", ...options }).format(date);
}

function clockText(value) {
  return dateText(value, { day: undefined, month: undefined, hour: "2-digit", minute: "2-digit" });
}

function dayText(value) {
  const date = dateValue(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function badge(status) {
  return `<span class="badge ${status === "answered" ? "badge--answered" : status === "done" ? "badge--done" : ""}">${escapeHtml(statuses[status] || status)}</span>`;
}

function setMessage(id, text, tone = "error", extra = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.className = text ? `form-message notice notice--${tone}` : "form-message";
  element.innerHTML = text ? `<p>${escapeHtml(text)}</p>${extra}` : "";
}

function renderConnection() {
  const paused = document.hidden;
  const offline = !navigator.onLine;
  connection.classList.toggle("is-error", offline || Boolean(connectionError));
  if (!isDoctor) connection.setAttribute("aria-live", offline || connectionError ? "polite" : "off");
  if (offline) {
    connection.innerHTML = '<span>Bağlantı yok. Yazdıklarınız bu ekranda korunuyor.</span><button type="button" data-action="refresh">Tekrar dene</button>';
  } else if (connectionError) {
    connection.innerHTML = `<span>${escapeHtml(connectionError)}</span><button type="button" data-action="refresh">Tekrar dene</button>`;
  } else if (lastSuccess) {
    connection.textContent = `${paused ? "Bu sekme açıkken yenilenir" : "10 saniyede bir yenilenir"} · Son kontrol ${clockText(lastSuccess)}`;
  } else {
    connection.textContent = "Bağlantı kuruluyor…";
  }
}

async function api(path, body, csrf) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || !data) {
      const error = new Error(data?.error?.message || "İşlem tamamlanamadı. Lütfen tekrar deneyin.");
      error.status = response.status || 502;
      error.code = data?.error?.code || "unknown";
      throw error;
    }
    lastSuccess = new Date();
    connectionError = "";
    renderConnection();
    return data;
  } catch (error) {
    if (!error.status) {
      const wrapped = new Error("Revir bağlantısına ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.");
      wrapped.code = "network";
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function setFormBusy(form, busy, label) {
  if (!form) return;
  form.dataset.busy = busy ? "true" : "false";
  form.querySelectorAll("input, textarea, select").forEach(field => {
    if (busy) { field.dataset.busyDisabled = field.disabled ? "true" : "false"; field.disabled = true; }
    else if (field.dataset.busyDisabled !== undefined) { field.disabled = field.dataset.busyDisabled === "true"; delete field.dataset.busyDisabled; }
  });
  const submit = form.querySelector('button[type="submit"]');
  if (submit) {
    submit.disabled = busy;
    if (busy) {
      submit.dataset.previousText = submit.textContent;
      submit.textContent = label || "Kaydediliyor…";
    } else if (submit.dataset.previousText) {
      submit.textContent = submit.dataset.previousText;
      delete submit.dataset.previousText;
    }
  }
  form.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = busy; });
}

function statusMarkup(availability = {}) {
  return `<div class="card status-card ${availability.accepting ? "" : "is-closed"}">
    <span class="badge ${availability.accepting ? "" : "badge--closed"}">${availability.accepting ? "Talep iletebilirsiniz" : "Şu anda talep alınmıyor"}</span>
    <h2>${escapeHtml(availability.headline || "Revir durumu")}</h2>
    <p class="status-detail">${escapeHtml(availability.detail || "")}</p>
    ${availability.statusMessage ? `<p class="status-message"><strong>Hekim notu:</strong> ${escapeHtml(availability.statusMessage)}</p>` : ""}
    ${availability.returnAt ? `<p class="helper">Belirtilen dönüş saati: <strong>${escapeHtml(clockText(availability.returnAt))}</strong>. Durum hekim tarafından güncellenir.</p>` : ""}
  </div>`;
}

function scheduleMarkup(schedule = []) {
  return `<div class="card card--soft"><h2>Haftalık revir saatleri</h2><div class="schedule-list">${[1, 2, 3, 4, 5, 6, 0].map(index => {
    const row = schedule[index] || {};
    return `<div class="schedule-line"><span>${days[index]}</span><span>${row.open ? `${escapeHtml(row.start)} – ${escapeHtml(row.end)}` : "Kapalı"}</span></div>`;
  }).join("")}</div><p class="helper space-top">Saatler Türkiye saatidir. Bugüne özel değişiklikler üstteki revir durumunda görünür.</p></div>`;
}

function phoneInfo(value) {
  const phone = String(value || "").trim();
  if (!phone || !/^[+\d\s().-]+$/.test(phone)) return null;
  const normalized = phone.replace(/[\s().-]/g, "");
  if (!/^\+?\d{3,15}$/.test(normalized)) return null;
  const international = /^05\d{9}$/.test(normalized) ? `+90${normalized.slice(1)}` : normalized;
  const whatsapp = /^\+\d{10,15}$/.test(international) ? international.slice(1) : null;
  return { display: phone, dial: normalized, whatsapp };
}

function contactDetailsMarkup(contacts = {}) {
  const phone = phoneInfo(contacts.workPhone);
  const additionalPhone = phone && phone.whatsapp !== officialContact.dial.slice(1) ? phone : null;
  return `<h2>İşyeri hekimi</h2><p class="physician-name">${escapeHtml(officialContact.name)}</p>
    <div class="physician-details"><p>${escapeHtml(officialContact.phone)}</p><a href="mailto:${escapeHtml(officialContact.email)}">${escapeHtml(officialContact.email)}</a></div>
    <p class="helper">Revir kapalıyken de bu iletişim bilgilerini kullanabilirsiniz.</p>
    <a class="button button--small" href="https://wa.me/905000000000" target="_blank" rel="noopener noreferrer">WhatsApp ile yaz</a>
    <p class="helper space-top">WhatsApp ayrı bir uygulamada açılır; mesajı siz gönderirsiniz. Kimlik veya sağlık bilgisi paylaşmayın.</p>
    ${additionalPhone ? `<div class="additional-contact"><p class="contact-note">Revir iş telefonu: <strong>${escapeHtml(additionalPhone.display)}</strong></p><div class="actions"><a class="button button--small" href="tel:${escapeHtml(additionalPhone.dial)}">İş telefonunu ara</a>${additionalPhone.whatsapp ? `<a class="button button--small" href="https://wa.me/${escapeHtml(additionalPhone.whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp’ı aç</a>` : ""}</div></div>` : ""}`;
}

function contactsMarkup(contacts = {}) {
  return `<section class="worker-contact-area physician-contact" aria-label="İşyeri hekimi iletişim bilgileri">
    <p class="worker-call-help">Bekleyemeyecek bir ihtiyacınız varsa arayın. Rutin işlemler için önce buradan haber verin.</p>
    <a class="button physician-call worker-call" href="tel:${escapeHtml(officialContact.dial)}"><span aria-hidden="true">☎</span> Hekimi ara</a>
    <details id="worker-contact-details" class="worker-details"><summary>Hekim iletişim bilgileri</summary><div id="worker-contact-info" class="worker-details-body">${contactDetailsMarkup(contacts)}</div></details>
  </section>`;
}

function emergencyMarkup(contacts = {}) {
  return `<section class="worker-emergency" aria-label="Acil durum">
    <h2><span aria-hidden="true">🚑</span> Acil bir sağlık durumu mu var?</h2>
    <p>Doktoru veya yanıtını beklemeyin. Aşağıdaki düğmeye dokunarak acil hattını arayın.</p>
    <a class="worker-emergency-call" href="tel:112" aria-label="Acil Durum Hattı 112, arama ekranını aç"><span aria-hidden="true">☎</span> <strong>112’yi ara</strong><span class="worker-call-arrow" aria-hidden="true">↗</span></a>
    <p>Bağlanınca ilk yardım için <strong>kurumunuzun tuşlama sırasını</strong> izleyin.</p>
    ${contacts.emergencyText ? `<p class="worker-emergency-note">${escapeHtml(contacts.emergencyText)}</p>` : ""}
  </section>`;
}

function workerStatusMarkup(availability = {}) {
  const label = availability.accepting ? "Talep iletebilirsiniz" : "Şu anda talep alınmıyor";
  const headline = availability.headline && availability.headline !== label && !/^Revir talep kabul (ediyor|etmiyor)$/.test(availability.headline) ? availability.headline : "";
  return `<div class="worker-availability ${availability.accepting ? "" : "is-closed"}">
    <p class="worker-availability-title"><span class="worker-status-dot" aria-hidden="true"></span>${label}</p>
    ${headline ? `<p class="worker-status-headline">${escapeHtml(headline)}</p>` : ""}
    ${!availability.accepting && availability.detail ? `<p class="worker-status-detail">${escapeHtml(availability.detail)}</p>` : ""}
    ${availability.returnAt ? `<p class="worker-status-detail">Hekimin belirttiği yaklaşık dönüş: <strong>${escapeHtml(clockText(availability.returnAt))}</strong></p>` : ""}
    ${availability.statusMessage ? `<p class="worker-status-detail"><strong>Hekim notu:</strong> ${escapeHtml(availability.statusMessage)}</p>` : ""}
  </div>`;
}

function workerMessageFormMarkup() {
  return `<details id="worker-message-details" class="worker-details" hidden><summary>Hekime mesaj ilet <span>İsteğe bağlı</span></summary><div class="worker-details-body">
    <p id="worker-message-target" class="worker-message-target"></p><p class="helper">Mesajınız bu talebe eklenir; yeni talep oluşturmaz. Hekim yanıtından sonra bekleme durumunuzu seçebilirsiniz.</p>
    <form id="worker-message-form"><div class="field"><label for="worker-message-text">Kısa mesajınız <span>· isteğe bağlı</span></label><textarea id="worker-message-text" maxlength="300" placeholder="Örneğin: Bana ulaşabileceğiniz numaramı ekliyorum."></textarea></div>
      <div class="field"><label for="worker-message-name">İsim soyisim <span>· isteğe bağlı</span></label><input id="worker-message-name" autocomplete="name" maxlength="80"></div>
      <div class="field"><label for="worker-message-phone">Telefon <span>· isteğe bağlı</span></label><input id="worker-message-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30"></div>
      <p class="helper">En az bir alanı doldurun. Kimlik numarası, tanı veya özel sağlık bilgisi yazmayın. Yanıtı bu sayfadan takip edin.</p>
      <div id="worker-message-status" class="form-message" role="status" aria-live="polite"></div><button id="worker-message-submit" class="button button--full" type="submit">Hekime ilet</button>
    </form></div></details>`;
}

function workerFeedbackMarkup() {
  return `<details id="worker-feedback-details" class="worker-details worker-feedback"><summary>Uygulama için görüş / hata bildir</summary><div class="worker-details-body">
    <p class="helper">Yalnız uygulama hakkındaki görüşler içindir. Hekime talep veya mesaj iletmez; acil durumlar için kullanmayın.</p>
    <form id="worker-feedback-form"><div class="field"><label for="worker-feedback-category">Konu</label><select id="worker-feedback-category"><option value="suggestion">Öneri</option><option value="bug">Bir hata gördüm</option><option value="other">Diğer görüş</option></select></div>
      <div class="field"><label for="worker-feedback-text">Görüşünüz</label><textarea id="worker-feedback-text" required maxlength="500" placeholder="Örneğin: Bir düğmeye dokununca sayfa açılmadı."></textarea></div>
      <p class="helper">İsim veya telefon gerekmez. Kimlik veya sağlık bilgisi yazmayın. Görüşünüz 7 gün içinde silinir.</p>
      <div id="worker-feedback-status" class="form-message" role="status" aria-live="polite"></div><button id="worker-feedback-submit" class="button button--full" type="submit">Görüşü gönder</button>
    </form></div></details>`;
}

function workerMessageDraftFromFields() {
  return { text: document.getElementById("worker-message-text").value, fullName: document.getElementById("worker-message-name").value, phone: document.getElementById("worker-message-phone").value };
}

function rememberWorkerMessageDraft() {
  if (workerMessageTargetId) workerMessageDrafts.set(workerMessageTargetId, workerMessageDraftFromFields());
}

function adoptWorkerRequest(request) {
  if (!request || !publicState) return null;
  let adopted = null;
  publicState.requests = publicState.requests.map(current => {
    if (current.id !== request.id) return current;
    // Notes and presence can finish out of order. Keep the newest saved record.
    adopted = request.version >= current.version ? request : current;
    return adopted;
  });
  return adopted;
}

function renderWorkerMessage(item) {
  const panel = document.getElementById("worker-message-details");
  panel.hidden = !item || item.status === "done";
  const id = item?.id || "";
  if (id !== workerMessageTargetId) {
    rememberWorkerMessageDraft();
    workerMessageTargetId = id;
    const draft = workerMessageDrafts.get(id) || { text: "", fullName: "", phone: "" };
    for (const [field, value] of Object.entries({ text: draft.text, name: draft.fullName, phone: draft.phone })) document.getElementById(`worker-message-${field}`).value = value;
    panel.open = false;
  }
  const save = workerMessageSaves.get(id);
  document.getElementById("worker-message-target").textContent = item ? `${item.visitorCode || "Talebiniz"} · ${dateText(item.createdAt)}` : "";
  document.getElementById("worker-message-form").querySelectorAll("input, textarea, button").forEach(field => { field.disabled = Boolean(save?.busy); });
  document.getElementById("worker-message-submit").textContent = save?.busy ? "İletiliyor…" : "Hekime ilet";
  setMessage("worker-message-status", save?.message || "", save?.tone || "error");
}

async function submitWorkerMessage() {
  const id = workerMessageTargetId;
  const item = publicState?.requests.find(row => row.id === id);
  if (!item || item.status === "done" || workerMessageSaves.get(id)?.busy) return;
  const fields = workerMessageDraftFromFields();
  rememberWorkerMessageDraft();
  const bodyFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]));
  if (!Object.values(bodyFields).some(Boolean)) { setMessage("worker-message-status", "Kısa bir not, isim veya telefon ekleyin."); return; }
  const fingerprint = JSON.stringify(bodyFields);
  const previous = workerMessageSaves.get(id);
  const operationId = previous?.fingerprint === fingerprint && previous.operationId ? previous.operationId : crypto.randomUUID();
  const save = { operationId, fingerprint, busy: true, message: "", tone: "error" };
  workerMessageSaves.set(id, save);
  publicEpoch++;
  renderWorkerMessage(item);
  try {
    const result = await api(`/api/requests/${encodeURIComponent(id)}/messages`, { operationId, ...bodyFields }, publicState.csrfToken);
    publicEpoch++;
    adoptWorkerRequest(result.request);
    workerMessageDrafts.delete(id);
    if (workerMessageTargetId === id) for (const field of ["text", "name", "phone"]) document.getElementById(`worker-message-${field}`).value = "";
    save.operationId = null; save.message = "Hekime iletildi. Yanıtı bu sayfadan takip edebilirsiniz."; save.tone = "success";
  } catch (error) {
    save.message = `${error.message} Yazdıklarınız korunuyor.`;
    if ([401, 403, 404, 409].includes(error.status)) await refreshPublic(true);
  } finally {
    save.busy = false;
    renderWorker();
  }
}

async function submitWorkerFeedback() {
  const form = document.getElementById("worker-feedback-form");
  if (form.dataset.busy === "true" || !publicState) return;
  const fields = { text: document.getElementById("worker-feedback-text").value.trim(), category: document.getElementById("worker-feedback-category").value || "suggestion" };
  if (!fields.text) { setMessage("worker-feedback-status", "Görüşünüzü kısaca yazın."); return; }
  const fingerprint = JSON.stringify(fields);
  if (workerFeedbackOperation?.fingerprint !== fingerprint) workerFeedbackOperation = { operationId: crypto.randomUUID(), fingerprint };
  const body = { operationId: workerFeedbackOperation.operationId, ...fields };
  form.dataset.busy = "true";
  form.querySelectorAll("textarea, select, button").forEach(field => { field.disabled = true; });
  document.getElementById("worker-feedback-submit").textContent = "Gönderiliyor…";
  setMessage("worker-feedback-status", "");
  try {
    await api("/api/feedback", body, publicState.csrfToken);
    document.getElementById("worker-feedback-text").value = "";
    workerFeedbackOperation = null;
    setMessage("worker-feedback-status", "Görüşünüz kaydedildi. Teşekkürler.", "success");
  } catch (error) {
    setMessage("worker-feedback-status", `${error.message} Yazdıklarınız korunuyor.`);
    if ([401, 403].includes(error.status)) await refreshPublic(true);
  } finally {
    form.dataset.busy = "false";
    form.querySelectorAll("textarea, select, button").forEach(field => { field.disabled = false; });
    document.getElementById("worker-feedback-submit").textContent = "Görüşü gönder";
  }
}

function requestMessagesMarkup(item, employee = false) {
  if (!item.messages?.length) return "";
  return `<details class="request-messages" ${employee ? "" : "open"}><summary>${employee ? "Gönderdiğiniz notlar" : "Çalışanın notları"} (${item.messages.length})</summary><ul>${item.messages.map(message => `<li><p class="request-meta">${escapeHtml(dateText(message.createdAt))}</p>${message.text ? `<p>${escapeHtml(message.text)}</p>` : ""}${message.fullName || message.phone ? `<p class="helper">${escapeHtml([message.fullName, message.phone].filter(Boolean).join(" · "))}</p>` : ""}</li>`).join("")}</ul></details>`;
}

function renderDoctorMessageSummary() {
  const reported = doctorState.requests.filter(item => item.status !== "done" && item.messageVersion > 0).sort((a,b) => new Date(b.latestMessageAt) - new Date(a.latestMessageAt));
  document.getElementById("doctor-message-summary").hidden = !reported.length;
  updateWorkerHtml("doctor-message-summary", reported.length ? `<h2>Çalışanların son mesajları</h2><ul class="doctor-left-list">${reported.slice(0,3).map(item => `<li class="is-message"><span><strong>${escapeHtml(item.visitorCode || "Talep")}</strong><span>Mesaj iletti · ${escapeHtml(dateText(item.latestMessageAt))}</span></span><button class="button button--small" type="button" data-action="doctor-message-request" data-id="${escapeHtml(item.id)}">Mesajı aç</button></li>`).join("")}</ul>` : "");
}

async function loadDoctorFeedback() {
  if (!authenticated || doctorFeedbackLoading) return;
  const csrf = doctorCsrf;
  doctorFeedbackLoading = true;
  document.getElementById("doctor-feedback-load").disabled = true;
  setMessage("doctor-feedback-status", "");
  try {
    const result = await api("/api/doctor/feedback");
    if (!authenticated || !doctorMounted || doctorCsrf !== csrf) return;
    const labels = { suggestion: "Öneri", bug: "Hata bildirimi", other: "Diğer görüş" };
    updateWorkerHtml("doctor-feedback-list", result.feedback?.length ? `<ul class="feedback-list">${result.feedback.map(item => `<li><strong>${labels[item.category] || "Görüş"}</strong><span>${escapeHtml(dateText(item.createdAt))}</span><p>${escapeHtml(item.text)}</p></li>`).join("")}</ul>` : '<p class="helper">Henüz uygulama görüşü yok.</p>');
  } catch (error) {
    if (authenticated && doctorCsrf === csrf) setMessage("doctor-feedback-status", error.message);
  } finally {
    doctorFeedbackLoading = false;
    if (authenticated && doctorMounted) document.getElementById("doctor-feedback-load").disabled = false;
  }
}

function openDoctorFeedbackTarget(fromNotification = false) {
  if (!authenticated || !doctorMounted || (!fromNotification && (doctorFeedbackHashHandled || location.hash !== "#doctor-feedback-details"))) return;
  const details = document.getElementById("doctor-feedback-details");
  if (!details) return;
  doctorFeedbackHashHandled = true;
  details.open = true;
  details.scrollIntoView({ block: "start", behavior: "auto" });
  void loadDoctorFeedback();
}

function workerMarkup() {
  return `<div id="worker-layout" class="worker-page">
    <h1 class="worker-page-title">Revirle iletişim</h1>
    <div id="worker-announcement" class="worker-sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    <div id="worker-result" tabindex="-1" hidden></div>
    <div id="worker-status"></div>
    <button id="worker-reply-alert" class="worker-reply-alert" type="button" data-action="worker-latest-reply" hidden>Hekimden yanıt geldi · Yanıta git ↑</button>
    <section id="worker-form-panel" class="card worker-form-card" aria-labelledby="worker-form-title">
      <h2 id="worker-form-title" tabindex="-1">Geldiğinizi doktora bildirin</h2>
      <p class="worker-write-hint">Yazı yazmanız gerekmez.</p>
      <p id="worker-additional-request-hint" class="helper" hidden>Bu düğme ayrı bir talep açar. Mevcut talebinize mesaj eklemek veya bekleme durumunuzu bildirmek için “Talebime dön” düğmesine dokunun.</p>
      <form id="request-form">
        <div id="request-message" class="form-message" role="status" aria-live="polite"></div>
        <button class="button button--primary button--full worker-submit" type="submit">Geldiğimi doktora bildir</button>
        <p class="worker-response-hint">Yanıtı bu sayfadan görebilirsiniz.</p>
        <details id="worker-options" class="worker-details worker-options"><summary>Hekime not veya iletişim ekle <span>İsteğe bağlı</span></summary><div class="worker-details-body">
          <p class="helper">T.C. kimlik numarası, tanı veya özel sağlık bilgisi yazmayın.</p>
          <div class="field"><label for="request-note">Kısa not <span>· isteğe bağlı</span></label><textarea id="request-note" name="note" maxlength="300" placeholder="Örneğin: Revir önünde bekliyorum."></textarea><div class="field-meta"><span>Yalnızca hekim ekranında görünür.</span><span id="note-count">0 / 300</span></div></div>
          <div class="field"><label for="request-phone">İletişim numarası <span>· isteğe bağlı</span></label><input id="request-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" placeholder="Size ulaşılabilecek numara"></div>
          <div class="field"><label for="request-name">İsim soyisim <span>· isteğe bağlı</span></label><input id="request-name" name="fullName" type="text" autocomplete="name" maxlength="80" placeholder="İsterseniz adınızı yazın"></div>
          <button class="button button--primary button--full" type="submit">Geldiğimi doktora bildir</button>
        </div></details>
      </form>
      <button id="worker-cancel-request" class="worker-text-button" type="button" data-action="worker-cancel-request" hidden>Talebime dön</button>
    </section>
    <button id="worker-new-request" class="button worker-another-request" type="button" data-action="worker-new-request" hidden>Geldiğimi doktora bildir</button>
    <p id="worker-new-request-hint" class="worker-new-request-hint" hidden>Tekrar geldiğinizde bu düğmeye dokunun.</p>
    <details id="worker-other" class="worker-details worker-other" hidden><summary id="worker-other-summary">Diğer açık talepler</summary><div id="worker-other-list" class="worker-details-body"></div></details>
    ${workerMessageFormMarkup()}
    <div id="worker-contacts">${contactsMarkup()}</div>
    <div id="worker-emergency">${emergencyMarkup()}</div>
    <details id="worker-history-details" class="worker-details" hidden><summary id="worker-history-summary">Geçmiş talepler</summary><div id="worker-history" class="worker-details-body"></div></details>
    <details id="worker-schedule-details" class="worker-details"><summary>Revir saatleri ve kullanım bilgisi</summary><div class="worker-details-body"><div id="worker-schedule"></div><p class="helper space-top">Bu tarayıcıdaki talepler ve yanıtlar 7 gün görünür. Başka bir tarayıcıdaki veya gizli penceredeki kayıtlarınız burada görünmez. Ortak cihazda gizli pencere kullanın; işiniz bitince o pencereyi kapatın.</p><p class="helper">Talep alınması hekimin o anda revirde olduğu anlamına gelmez. Yanıt için bu sayfaya dönün; bu ekran telefon bildirimi göndermez.</p></div></details>
    ${workerFeedbackMarkup()}
  </div>`;
}

function loadOperation(formDate, forceNew = false) {
  let saved = null;
  if (!forceNew) {
    try { saved = JSON.parse(sessionStorage.getItem(operationStorageKey)); } catch { /* Storage can be disabled. */ }
  }
  // Keep an unresolved submission's identity across midnight and a page reload.
  // The server checks earlier submissions before accepting a new day's request.
  operation = saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(saved.operationId || "")
    ? { operationId: saved.operationId, formDate }
    : { operationId: crypto.randomUUID(), formDate };
  try { sessionStorage.setItem(operationStorageKey, JSON.stringify(operation)); } catch { /* In-memory retries remain available. */ }
}

function updateWorkerHtml(id, markup) {
  const element = document.getElementById(id);
  if (element && element.innerHTML !== markup) element.innerHTML = markup;
}

function workerReplyKey(item) {
  return item.reply ? `${item.replyVersion || ""}\n${item.repliedAt || ""}\n${item.reply}` : "";
}

function workerReplyMarker(item) {
  return item.replyVersion ? `${item.replyVersion}:${item.repliedAt || ""}` : item.repliedAt;
}

function validPresence(item) {
  return ["waiting", "left"].includes(item.presence);
}

function workerReplySeen(item) {
  if (!item.reply) return true;
  if (validPresence(item)) return true;
  if (workerSeenFallback.has(item.id)) return workerSeenFallback.get(item.id) === workerReplyKey(item);
  return Boolean(item.repliedAt && workerSeenReplies.get(item.id) === workerReplyMarker(item));
}

function saveWorkerSeenReplies() {
  try { sessionStorage.setItem(workerSeenStorageKey, JSON.stringify([...workerSeenReplies])); }
  catch { /* Acknowledgement still works for this open page. */ }
}

function syncWorkerReplies(records) {
  if (!workerSeenLoaded) {
    workerSeenLoaded = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(workerSeenStorageKey));
      if (Array.isArray(saved)) for (const row of saved) {
        if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string") workerSeenReplies.set(row[0], row[1]);
      }
    } catch { /* Storage can be disabled or contain an earlier invalid value. */ }
  }
  const changed = [];
  const activeIds = new Set(records.map(item => item.id));
  let pruned = false;
  for (const id of workerSeenReplies.keys()) if (!activeIds.has(id)) { workerSeenReplies.delete(id); pruned = true; }
  for (const map of [workerReplyVersions, workerSeenFallback]) for (const id of map.keys()) if (!activeIds.has(id)) map.delete(id);
  for (const item of records) {
    const key = workerReplyKey(item);
    if (workerReplyVersions.has(item.id) && workerReplyVersions.get(item.id) !== key) {
      workerSeenReplies.delete(item.id);
      workerSeenFallback.delete(item.id);
      pruned = true;
      if (key) changed.push(item);
    } else if (!workerReplyVersions.has(item.id) && key && !workerReplySeen(item)) changed.push(item);
    workerReplyVersions.set(item.id, key);
    const save = workerPresenceSaves.get(item.id);
    if (save && !save.busy && (save.replyVersion !== item.replyVersion || item.status === "done" || item.presence === save.choice)) workerPresenceSaves.delete(item.id);
  }
  for (const id of workerPresenceSaves.keys()) if (!activeIds.has(id)) workerPresenceSaves.delete(id);
  if (pruned) saveWorkerSeenReplies();
  changed.sort((a, b) => new Date(b.repliedAt || b.createdAt) - new Date(a.repliedAt || a.createdAt));
  if (changed.length) {
    workerSelectedRequestId = changed[0].id;
    const announcement = document.getElementById("worker-announcement");
    announcement.textContent = changed.length > 1 ? `${changed.length} talebinize hekim yanıt verdi. Yanıtlar sayfanın üstünde.` : "Hekimden yanıt geldi. Yanıt sayfanın üstünde.";
  }
}

function presenceLabel(item, employee = false) {
  if (item.presence === "waiting") return employee ? "Burada bekliyorum" : "Bekliyor";
  if (item.presence === "left") return employee ? "Ayrıldım, sonra geleceğim" : "Ayrıldı, sonra gelecek";
  return "Bekleme durumu belirtilmedi";
}

function workerPresenceMarkup(item) {
  const save = workerPresenceSaves.get(item.id);
  const busy = Boolean(save?.busy);
  const selected = validPresence(item);
  if (item.status === "done") return `<p class="worker-presence-status ${selected ? `is-${item.presence}` : ""}">${selected ? `Son bildiriminiz: ${escapeHtml(presenceLabel(item, true))} · ${escapeHtml(dateText(item.presenceUpdatedAt))}` : "Bekleme durumu belirtilmedi"}</p>`;
  return `<div class="worker-presence" aria-label="Bekleme durumunuzu hekime bildirin">
    <p class="worker-presence-question">${selected ? "Hekime bildirdiğiniz durum:" : "Burada bekleyecek misiniz?"}</p>
    ${selected ? `<p class="worker-presence-status is-${item.presence}"><strong>${escapeHtml(presenceLabel(item, true))}</strong><span>${escapeHtml(dateText(item.presenceUpdatedAt))}</span></p>` : ""}
    <div class="worker-presence-actions"><button class="button worker-presence-choice is-waiting" type="button" data-action="worker-presence" data-id="${escapeHtml(item.id)}" data-presence="waiting" aria-pressed="${item.presence === "waiting"}" ${busy || item.presence === "waiting" ? "disabled" : ""}><span aria-hidden="true">${item.presence === "waiting" ? "✓" : "○"}</span> Burada bekliyorum</button>
      <button class="button worker-presence-choice is-left" type="button" data-action="worker-presence" data-id="${escapeHtml(item.id)}" data-presence="left" aria-pressed="${item.presence === "left"}" ${busy || item.presence === "left" ? "disabled" : ""}><span aria-hidden="true">${item.presence === "left" ? "✓" : "↗"}</span> Ayrıldım, sonra geleceğim</button></div>
    ${busy ? '<p class="worker-presence-message" role="status">Hekime iletiliyor…</p>' : save?.message ? `<p class="notice notice--${save.tone || "error"} worker-presence-message" role="status">${escapeHtml(save.message)}</p>` : ""}
    <p class="worker-presence-help">${selected ? "Durumunuz değişirse diğer seçeneğe dokunun." : "Bir seçeneğe dokunun; durumunuz hekime iletilsin."}</p>
  </div>`;
}

function workerResultMarkup(item) {
  const unseen = item.reply && !workerReplySeen(item);
  const title = item.reply ? "Hekimden yanıt geldi" : item.status === "done" ? "Talebiniz tamamlandı" : "Talebiniz iletildi";
  return `<section class="worker-result-card ${item.reply ? "has-answer" : item.status === "done" ? "is-done" : "is-waiting"}" aria-labelledby="worker-result-title">
    <div class="worker-result-heading"><span class="worker-result-icon" aria-hidden="true">${item.reply ? "✉" : "✓"}</span><h2 id="worker-result-title">${title}</h2>${item.status === "done" ? badge("done") : ""}</div>
    ${item.reply ? `<div class="worker-answer-box"><p class="worker-answer-text">${escapeHtml(item.reply)}</p><p class="worker-result-meta">${escapeHtml(dateText(item.repliedAt))}</p></div>${workerPresenceMarkup(item)}${item.status === "done" && unseen ? `<button type="button" class="button worker-ack" data-action="worker-ack" data-id="${escapeHtml(item.id)}">Yanıtı gördüm</button>` : ""}` : `<p class="worker-waiting-text">${item.status === "done" ? "Hekim bu talebi tamamladı." : "Yanıt bekleniyor."}</p>${item.status === "done" ? "" : '<div class="worker-keep-open"><strong class="worker-keep-open-title">Bu sayfayı kapatmayın</strong><p>Doktor müsait olduğunda yanıtı burada göreceksiniz.</p></div>'}`}
    ${requestMessagesMarkup(item, true)}
    <div class="worker-own-request">${item.visitorCode ? `<p class="worker-visitor-code">Takip kodunuz: <strong>${escapeHtml(item.visitorCode)}</strong></p>` : ""}<p>Talep · ${escapeHtml(dateText(item.createdAt))}</p>${item.note ? `<p class="worker-own-note">${escapeHtml(item.note)}</p>` : ""}</div>
  </section>`;
}

function workerListMarkup(records) {
  return `<ul class="worker-request-list">${records.map(item => `<li><button type="button" class="worker-request-choice" data-action="worker-select" data-id="${escapeHtml(item.id)}">
    <span class="worker-choice-heading"><strong>${item.reply && !workerReplySeen(item) ? "Görülmemiş hekim yanıtı" : item.reply ? "Hekim yanıtı" : item.status === "done" ? "Tamamlandı" : "Yanıt bekleniyor"}</strong><span aria-hidden="true">↗</span></span>
    <span class="worker-choice-date">${item.visitorCode ? `<strong>${escapeHtml(item.visitorCode)}</strong> · ` : ""}${escapeHtml(dateText(item.createdAt))}</span>${item.note ? `<span class="worker-choice-note">${escapeHtml(item.note)}</span>` : ""}
    ${item.reply ? `<span class="worker-choice-reply">${escapeHtml(item.reply)}</span>` : ""}
    ${validPresence(item) ? `<span class="worker-choice-date">${escapeHtml(presenceLabel(item, true))} · ${escapeHtml(clockText(item.presenceUpdatedAt))}</span>` : ""}
  </button></li>`).join("")}</ul>`;
}

function focusWorkerResult() {
  const result = document.getElementById("worker-result");
  if (!result || result.hidden) return;
  result.focus({ preventScroll: true });
  result.scrollIntoView({ block: "start", behavior: "auto" });
}

function selectWorkerRequest(id) {
  if (!publicState?.requests.some(item => item.id === id)) return;
  workerSelectedRequestId = id;
  renderWorker();
  focusWorkerResult();
}

function acknowledgeWorkerReply(id) {
  const item = publicState?.requests.find(row => row.id === id);
  if (!item?.reply) return;
  if (item.repliedAt) workerSeenReplies.set(id, workerReplyMarker(item));
  workerSeenFallback.set(id, workerReplyKey(item));
  saveWorkerSeenReplies();
  const next = publicState.requests.filter(row => row.reply && !workerReplySeen(row)).sort((a, b) => new Date(b.repliedAt || b.createdAt) - new Date(a.repliedAt || a.createdAt))[0];
  workerSelectedRequestId = next?.id || id;
  renderWorker();
  document.getElementById("worker-announcement").textContent = next ? "Bir başka talebinizin yanıtı yukarıda gösteriliyor." : "Yanıt görüldü olarak işaretlendi.";
  focusWorkerResult();
}

async function submitWorkerPresence(id, choice) {
  const item = publicState?.requests.find(row => row.id === id);
  if (!item || item.status !== "answered" || !item.reply || !["waiting", "left"].includes(choice) || workerPresenceSaves.get(id)?.busy) return;
  const body = { presence: choice, expectedVersion: item.version, expectedReplyVersion: item.replyVersion };
  const save = { busy: true, choice, replyVersion: item.replyVersion, message: "", tone: "error" };
  workerPresenceSaves.set(id, save);
  publicEpoch++;
  renderWorker();
  try {
    const result = await api(`/api/requests/${encodeURIComponent(id)}/presence`, body, publicState.csrfToken);
    publicEpoch++;
    if (result.request) {
      const confirmed = adoptWorkerRequest(result.request);
      if (result.csrfToken) publicState.csrfToken = result.csrfToken;
      if (confirmed?.replyVersion === body.expectedReplyVersion && confirmed.presence === choice && validPresence(confirmed)) {
        if (confirmed.repliedAt) workerSeenReplies.set(id, workerReplyMarker(confirmed));
        workerSeenFallback.set(id, workerReplyKey(confirmed));
        saveWorkerSeenReplies();
        document.getElementById("worker-announcement").textContent = "Bekleme durumunuz hekime iletildi.";
      }
    }
    workerPresenceSaves.delete(id);
    renderWorker();
    await refreshPublic(true);
  } catch (error) {
    save.busy = false;
    save.message = error.status === 409 ? "Talebiniz güncellendi. Güncel yanıtı kontrol edip durumunuzu yeniden seçin." : `${error.message} Seçiminiz doğrulanmadı; tekrar deneyebilirsiniz.`;
    save.tone = error.status === 409 ? "warning" : "error";
    if ([401, 403, 404, 409].includes(error.status)) await refreshPublic(true);
  } finally {
    save.busy = false;
    renderWorker();
  }
}

function openWorkerForm() {
  workerFormOpen = true;
  renderWorker();
  const panel = document.getElementById("worker-form-panel");
  if (!panel.hidden) {
    document.getElementById("worker-form-title").focus({ preventScroll: true });
    panel.scrollIntoView({ block: "start", behavior: "auto" });
  }
}

function renderWorker() {
  if (!publicState) return;
  if (!workerMounted) {
    app.innerHTML = workerMarkup();
    workerMounted = true;
    loadOperation(publicState.formDate);
  } else if (operation?.formDate !== publicState.formDate) {
    loadOperation(publicState.formDate);
  }
  updateWorkerHtml("worker-status", workerStatusMarkup(publicState.availability));
  document.querySelector("#worker-layout").classList.toggle("is-closed", !publicState.availability.accepting);
  updateWorkerHtml("worker-schedule", scheduleMarkup(publicState.schedule));
  updateWorkerHtml("worker-contact-info", contactDetailsMarkup(publicState.contacts));
  updateWorkerHtml("worker-emergency", emergencyMarkup(publicState.contacts));
  const form = document.querySelector("#request-form");
  if (form.dataset.busy !== "true") {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = !publicState.availability.accepting || Date.now() < requestReadyAt;
    button.textContent = publicState.availability.accepting ? workerRetryPending ? "Tekrar dene" : "Geldiğimi doktora bildir" : "Şu anda talep alınmıyor";
    form.querySelectorAll('button[type="submit"]').forEach(other => { other.disabled = button.disabled; });
  }
  const records = [...publicState.requests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  syncWorkerReplies(records);
  let selected = records.find(item => item.id === workerSelectedRequestId);
  if (!selected) selected = records.find(item => item.reply && !workerReplySeen(item)) || records.find(item => item.status !== "done") || records[0];
  workerSelectedRequestId = selected?.id || "";
  document.getElementById("worker-result").hidden = !selected;
  updateWorkerHtml("worker-result", selected ? workerResultMarkup(selected) : "");
  renderWorkerMessage(selected);
  const hasDraft = ["request-note", "request-phone", "request-name"].some(id => document.getElementById(id).value.trim());
  const showForm = workerFormOpen || hasDraft || (!records.length && publicState.availability.accepting);
  // Keep a draft mounted and visible if clinic acceptance changes while typing.
  document.getElementById("worker-form-panel").hidden = !showForm;
  const hasActiveRequest = records.some(item => item.status === "new" || item.status === "answered");
  document.getElementById("worker-form-title").textContent = workerRetryPending ? "Gönderimi tekrar dene" : hasActiveRequest ? "Yeni geliş bildirimi" : "Geldiğinizi doktora bildirin";
  document.getElementById("worker-additional-request-hint").hidden = !hasActiveRequest;
  document.getElementById("worker-cancel-request").hidden = !records.length;
  const another = document.getElementById("worker-new-request");
  another.hidden = !records.length || showForm || !publicState.availability.accepting;
  another.disabled = form.dataset.busy === "true" || Date.now() < requestReadyAt;
  another.classList.toggle("worker-another-request", !hasActiveRequest);
  another.textContent = form.dataset.busy === "true" ? "İletiliyor…" : workerRetryPending ? "Gönderimi tekrar dene" : hasActiveRequest ? "Yeni bir geliş bildir" : "Geldiğimi doktora bildir";
  const anotherHint = document.getElementById("worker-new-request-hint");
  anotherHint.hidden = another.hidden || workerRetryPending;
  anotherHint.textContent = hasActiveRequest ? "Mevcut talebiniz açık. Bu seçenek ayrı bir geliş içindir." : "Tekrar geldiğinizde bu düğmeye dokunun.";
  document.getElementById("worker-reply-alert").hidden = !showForm || !records.some(item => item.reply && !workerReplySeen(item));
  const others = records.filter(item => item.id !== selected?.id && (item.status !== "done" || (item.reply && !workerReplySeen(item))));
  document.getElementById("worker-other").hidden = !others.length;
  document.getElementById("worker-other-summary").textContent = `Diğer talepler (${others.length})`;
  updateWorkerHtml("worker-other-list", workerListMarkup(others));
  const history = records.filter(item => item.id !== selected?.id && item.status === "done" && (!item.reply || workerReplySeen(item)));
  document.getElementById("worker-history-details").hidden = !history.length;
  document.getElementById("worker-history-summary").textContent = `Geçmiş talepler (${history.length})`;
  updateWorkerHtml("worker-history", workerListMarkup(history));
}

function refreshPublic(waitForFresh = false) {
  if (publicReadPromise) return waitForFresh ? publicReadPromise.then(() => refreshPublic()) : publicReadPromise;
  const epoch = publicEpoch;
  publicReadPromise = (async () => {
    try {
      const state = await api("/api/public");
      if (epoch !== publicEpoch) return;
      publicState = state;
      renderWorker();
    } catch (error) {
      if (epoch !== publicEpoch) return;
      connectionError = error.message;
      if (!workerMounted) app.innerHTML = `<div class="worker-page"><div class="card loading"><h1>Revir sayfasına ulaşılamadı.</h1><p class="muted">${escapeHtml(error.message)}</p><button class="button button--primary" type="button" data-action="refresh">Tekrar dene</button></div>${contactsMarkup()}${emergencyMarkup()}</div>`;
      renderConnection();
    } finally { publicReadPromise = null; }
  })();
  return publicReadPromise;
}

async function submitRequest(form) {
  if (form.dataset.busy === "true" || !publicState || Date.now() < requestReadyAt) return;
  if (!operation || operation.formDate !== publicState.formDate) loadOperation(publicState.formDate);
  const data = new FormData(form);
  const body = { ...operation, note: data.get("note"), phone: data.get("phone"), fullName: data.get("fullName") };
  setMessage("request-message", "");
  setFormBusy(form, true, "İletiliyor…");
  renderWorker();
  publicEpoch++;
  try {
    const result = await api("/api/requests", body, publicState.csrfToken);
    publicEpoch++;
    const newerRequest = result.request && publicState.requests.find(item => item.id === result.request.id && item.version > result.request.version);
    const confirmedRequest = newerRequest || result.request;
    if (confirmedRequest) {
      // A slow creation response can arrive after polling has already found a
      // physician answer. Confirmation must not replace that newer record.
      publicState.requests = [confirmedRequest, ...publicState.requests.filter(item => item.id !== confirmedRequest.id)];
      if (result.csrfToken) publicState.csrfToken = result.csrfToken;
      // An idempotent retry also confirms this submission. Clear it before
      // creating the next identity so another click cannot resend old fields.
      form.reset();
      document.querySelector("#note-count").textContent = "0 / 300";
      document.getElementById("worker-options").open = false;
      workerFormOpen = false;
      workerRetryPending = false;
      workerSelectedRequestId = confirmedRequest.id;
      loadOperation(publicState.formDate, true);
      // Absorb a physical double tap even if the first response was very fast.
      requestReadyAt = Date.now() + 800;
      if (requestCooldownTimer !== null) clearTimeout(requestCooldownTimer);
      requestCooldownTimer = setTimeout(() => { requestCooldownTimer = null; renderWorker(); }, 800);
    }
    setMessage("request-message", confirmedRequest ? "" : result.message || "Talebiniz doktora iletildi. Yanıtı bu sayfada görebilirsiniz.", "success");
    renderWorker();
    if (confirmedRequest) {
      document.getElementById("worker-announcement").textContent = confirmedRequest.reply ? "Talebinizin hekim yanıtı yukarıda." : "Talebiniz iletildi. Yanıt bekleniyor.";
      focusWorkerResult();
    }
    await refreshPublic(true);
  } catch (error) {
    workerRetryPending = true;
    workerFormOpen = true;
    setMessage("request-message", error.message, error.status === 409 ? "warning" : "error");
    if (error.status === 409 || error.status === 403 || error.status === 401) await refreshPublic(true);
    openWorkerForm();
  } finally {
    setFormBusy(form, false);
    renderWorker();
  }
}

function renderLogin(message = "", csrf = doctorCsrf) {
  pushGeneration++;
  pushLoadPromise = null;
  pushRenewedEndpoint = "";
  pushState = { loaded: false, configured: false, publicKey: "", subscription: null, busy: false, message: "", tone: "error" };
  authenticated = false;
  doctorCsrf = csrf || "";
  doctorEmail = "";
  doctorMounted = false;
  doctorFeedbackHashHandled = false;
  doctorPauseMessage = "";
  doctorPauseNoticeDate = "";
  doctorPauseNoticeState = null;
  doctorState = null;
  settingsDirty = false;
  settingsConflict = false;
  settingsVersion = null;
  settingsDate = null;
  settingsVisibleKey = "";
  requestsFingerprint = "";
  drafts.clear();
  document.querySelector("#header-actions").innerHTML = '<a class="header-link" href="/">Çalışan sayfası</a>';
  if (!loginMounted) {
    app.innerHTML = `<div class="login-wrap"><div class="card"><span class="eyebrow">Yetkili hekim</span><h1>Hekim ekranına giriş yapın.</h1><p class="lead">Size verilen hekim şifresini kullanın.</p>
      <form id="login-form"><div class="field"><label for="doctor-password">Hekim şifresi</label><input id="doctor-password" name="password" type="password" autocomplete="current-password" maxlength="256" required placeholder="Size verilen özel hekim şifresi"></div>
      <div id="login-message" class="form-message" role="status" aria-live="polite"></div>
      <button class="button button--primary button--full" type="submit">Giriş yap</button></form>
      <p class="helper space-top">Bu şifre yalnızca hekim içindir. Çalışanlar giriş yapmadan kendi sayfalarını kullanır. Ortak cihazda işiniz bitince Çıkış’a basın.</p></div></div>`;
    loginMounted = true;
  }
  setMessage("login-message", message, "warning");
}

function readDoctorSession() {
  if (!doctorSessionPromise) {
    doctorSessionPromise = api("/api/doctor/session").finally(() => { doctorSessionPromise = null; });
  }
  return doctorSessionPromise;
}

async function showDoctorLogin(message) {
  doctorEpoch++;
  const epoch = doctorEpoch;
  renderLogin(message, "");
  try {
    const session = await readDoctorSession();
    if (epoch === doctorEpoch) renderLogin(message, session.csrfToken);
  } catch (error) {
    if (epoch !== doctorEpoch) return;
    connectionError = error.message;
    renderConnection();
  }
}

function scheduleFormMarkup() {
  return [1, 2, 3, 4, 5, 6, 0].map(index => `<div class="schedule-row"><label class="check-label"><input type="checkbox" name="day-${index}-open">${days[index]}</label><input type="time" name="day-${index}-start" aria-label="${days[index]} açılış saati" required><span class="time-separator">–</span><input type="time" name="day-${index}-end" aria-label="${days[index]} kapanış saati" required></div>`).join("");
}

function pushEnvironment() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || Boolean(window.matchMedia?.("(display-mode: standalone)").matches);
  const supported = window.isSecureContext !== false && Boolean(navigator.serviceWorker && window.PushManager && window.Notification);
  return { ios, standalone, supported, needsInstall: ios && !standalone };
}

function renderPushPanel() {
  if (!authenticated || !doctorMounted) return;
  const panel = document.querySelector("#doctor-push");
  if (!panel) return;
  const environment = pushEnvironment();
  const permission = window.Notification?.permission || "default";
  let content;
  if (environment.needsInstall) {
    content = '<p>iPhone bildirimi için bu hekim sayfasını Safari’de açın. <strong>Paylaş → Ana Ekrana Ekle → Ekle</strong> adımlarından sonra oluşan Revir Hekim simgesinden giriş yapın.</p><p class="helper">iOS 16.4 veya üzeri gerekir. Görünüyorsa “Web Uygulaması Olarak Aç” seçeneğini açık bırakın. Ardından buradaki Bildirimleri aç düğmesine dokunun.</p>';
  } else if (!environment.supported) {
    content = '<p>Bu tarayıcı telefon bildirimini desteklemiyor. iPhone’da iOS 16.4 veya üzeriyle Safari’den ana ekrana ekleyin; bilgisayarda güncel bir tarayıcı kullanın.</p>';
  } else if (!pushState.loaded) {
    content = '<p class="helper">Bu cihazın bildirim ayarı kontrol ediliyor…</p>';
  } else if (!pushState.configured) {
    content = '<p>Bildirim bağlantısı henüz hazır değil. Biraz sonra yeniden deneyin.</p><button type="button" class="button button--small" data-action="push-reload">Yeniden kontrol et</button>';
  } else if (permission === "denied") {
    content = '<p>Bu cihazda bildirim izni kapalı. iPhone’da Ayarlar → Bildirimler → Revir Hekim bölümünden izin verin. Diğer tarayıcılarda bu sitenin bildirim iznini açın.</p><button type="button" class="button button--small" data-action="push-reload">İzni yeniden kontrol et</button>';
  } else {
    const subscribed = Boolean(pushState.subscription);
    content = `<p>${subscribed ? "Bu cihazda bildirim izni açık. Telefonunuzda göründüğünü test edin." : "Yeni geliş, mesaj veya bekleme durumu değişikliği geldiğinde telefonunuza kısa bir bildirim alabilirsiniz."}</p><div class="actions">
      <button type="button" class="button ${subscribed ? "button--small" : "button--primary"}" data-action="push-enable" ${pushState.busy ? "disabled" : ""}>${pushState.busy ? "İşlem yapılıyor…" : subscribed ? "Bağlantıyı yenile" : "Bildirimleri aç"}</button>
      ${subscribed ? `<button type="button" class="button button--small" data-action="push-test" ${pushState.busy ? "disabled" : ""}>Test bildirimi gönder</button><button type="button" class="button button--small button--plain" data-action="push-disable" ${pushState.busy ? "disabled" : ""}>Bu cihazda kapat</button>` : ""}
    </div>`;
  }
  panel.innerHTML = `<div class="section-heading"><h2 id="push-heading">Telefon bildirimleri</h2><span class="badge badge--answered">İsteğe bağlı</span></div>${content}<div id="push-message" class="form-message" role="status" aria-live="polite"></div><p class="helper space-top">Bildirimde isim, telefon veya talep notu gösterilmez. Bildirim gecikebilir; acil iletişim için kullanmayın. Oturum süresi dolunca talepleri görmek için yeniden giriş gerekir; Çıkış bu cihazın bildirimlerini de kapatır.</p><details class="space-top"><summary>iPhone’da bildirim sesi gelmiyor</summary><p class="helper space-top">Kilitliyken ses gelmiyorsa iPhone’da Ayarlar → Bildirimler → Revir Hekim → Sesler’i, Sessiz modunu ve Odak ayarlarını kontrol edin. Apple Watch kullanıyorsanız iPhone kilitliyken bildirim saate gidebilir.</p></details>`;
  setMessage("push-message", pushState.message, pushState.tone);
}

function pushRegistration() {
  if (!pushRegistrationPromise) {
    pushRegistrationPromise = navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(() => navigator.serviceWorker.ready)
      .catch(error => { pushRegistrationPromise = null; throw error; });
  }
  return pushRegistrationPromise;
}

async function loadPushPanel() {
  if (pushLoadPromise) return pushLoadPromise;
  if (!authenticated) return;
  const environment = pushEnvironment();
  renderPushPanel();
  if (environment.needsInstall || !environment.supported || pushState.busy) return;
  const generation = pushGeneration;
  pushState.busy = true;
  const pending = (async () => {
    try {
      const [configuration, registration] = await Promise.all([api("/api/doctor/push"), pushRegistration()]);
      const subscription = await registration.pushManager.getSubscription();
      if (!authenticated || generation !== pushGeneration) return;
      pushState.loaded = true;
      pushState.configured = Boolean(configuration.configured && configuration.publicKey);
      pushState.publicKey = configuration.publicKey || "";
      pushState.subscription = subscription;
      pushState.message = "";
      // Keep an already approved device current without prompting or creating
      // a browser subscription. The server still enforces its expiry limit.
      if (window.Notification.permission === "granted" && pushState.configured && subscription && pushRenewedEndpoint !== subscription.endpoint) {
        if (!currentPushSubscription(subscription, pushState.publicKey)) {
          pushState.message = "Bu cihazın bildirim bağlantısı yenilenemedi. Bu cihazda kapatıp bildirimleri yeniden açın.";
          pushState.tone = "warning";
          return;
        }
        try {
          await api("/api/doctor/push/subscribe", pushSubscriptionBody(subscription), doctorCsrf);
          if (!authenticated || generation !== pushGeneration) return;
          pushRenewedEndpoint = subscription.endpoint;
        } catch (error) {
          if (!authenticated || generation !== pushGeneration) return;
          pushState.message = "Bildirim bağlantısı yenilenemedi. İnternet bağlantınızı kontrol edip Bağlantıyı yenile düğmesine dokunun.";
          pushState.tone = "warning";
        }
      }
    } catch (error) {
      if (!authenticated || generation !== pushGeneration) return;
      pushState.loaded = true;
      pushState.message = error.status ? error.message : "Bu cihazın bildirim ayarı alınamadı. Bağlantınızı kontrol edip yeniden deneyin.";
      pushState.tone = "error";
    } finally {
      if (generation === pushGeneration) { pushState.busy = false; renderPushPanel(); }
    }
  })();
  pushLoadPromise = pending;
  try { await pending; }
  finally {
    if (pushLoadPromise === pending) pushLoadPromise = null;
  }
}

function applicationServerKey(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function currentPushSubscription(subscription, publicKey) {
  let expected;
  try { expected = applicationServerKey(publicKey); } catch { return false; }
  if (expected.length !== 65 || expected[0] !== 4) return false;
  const current = subscription.options?.applicationServerKey;
  if (current) {
    const bytes = new Uint8Array(current);
    if (bytes.length !== expected.length || bytes.some((byte, index) => byte !== expected[index])) return false;
  }
  const expires = subscription.expirationTime;
  return expires == null || (Number.isSafeInteger(expires) && expires > Date.now());
}

function pushSubscriptionBody(subscription) {
  const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const p256dh = subscription.getKey?.("p256dh");
  const auth = subscription.getKey?.("auth");
  return {
    endpoint: subscription.endpoint,
    ...(subscription.expirationTime == null ? {} : { expirationTime: subscription.expirationTime }),
    ...(p256dh && auth ? { keys: { p256dh: encode(p256dh), auth: encode(auth) } } : {}),
  };
}

async function enablePush() {
  if (!authenticated || pushState.busy || !pushState.configured || !pushEnvironment().supported || pushEnvironment().needsInstall) return;
  const generation = pushGeneration;
  pushState.busy = true;
  pushState.message = "";
  renderPushPanel();
  let createdSubscription = null;
  try {
    // No asynchronous work precedes this request inside the user's gesture.
    const permission = await (window.Notification.permission === "default"
      ? window.Notification.requestPermission() : window.Notification.permission);
    if (!authenticated || generation !== pushGeneration) return;
    if (permission !== "granted") {
      pushState.message = permission === "denied" ? "Bildirim izni verilmedi. İsterseniz daha sonra cihaz ayarlarından açabilirsiniz." : "Bildirim izni seçilmedi. Hazır olduğunuzda yeniden deneyebilirsiniz.";
      pushState.tone = "warning";
      return;
    }
    const registration = await pushRegistration();
    if (!authenticated || generation !== pushGeneration) return;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(pushState.publicKey) });
      createdSubscription = subscription;
    }
    if (!authenticated || generation !== pushGeneration) {
      if (createdSubscription) await createdSubscription.unsubscribe();
      return;
    }
    await api("/api/doctor/push/subscribe", pushSubscriptionBody(subscription), doctorCsrf);
    if (!authenticated || generation !== pushGeneration) {
      if (createdSubscription) await createdSubscription.unsubscribe();
      return;
    }
    pushState.subscription = subscription;
    pushRenewedEndpoint = subscription.endpoint;
    pushState.message = "Bu cihaz için bildirimler açıldı. Test bildirimi göndererek kontrol edin.";
    pushState.tone = "success";
  } catch (error) {
    if (createdSubscription) {
      try { await createdSubscription.unsubscribe(); } catch { /* A failed registration must not leave a new active browser subscription. */ }
    }
    if (authenticated && generation === pushGeneration) {
      pushState.message = error.status ? error.message : "Bildirimler açılamadı. Bağlantınızı ve bu sitenin bildirim iznini kontrol edip tekrar deneyin.";
      pushState.tone = "error";
    }
  } finally {
    if (generation === pushGeneration) { pushState.busy = false; renderPushPanel(); }
  }
}

async function testPush() {
  if (!authenticated || pushState.busy || !pushState.subscription) return;
  const generation = pushGeneration;
  pushState.busy = true;
  pushState.message = "";
  renderPushPanel();
  try {
    const endpoint = pushState.subscription.endpoint;
    await api("/api/doctor/push/subscribe", pushSubscriptionBody(pushState.subscription), doctorCsrf);
    if (!authenticated || generation !== pushGeneration) return;
    pushRenewedEndpoint = endpoint;
    await api("/api/doctor/push/test", { endpoint }, doctorCsrf);
    if (authenticated && generation === pushGeneration) {
      pushState.message = "Test bildirimi gönderildi. Telefonunuzda göründüğünü kontrol edin.";
      pushState.tone = "success";
    }
  } catch (error) {
    if (authenticated && generation === pushGeneration) {
      pushState.message = error.status ? error.message : "Test bildirimi gönderilemedi. Bağlantınızı kontrol edip yeniden deneyin.";
      pushState.tone = "error";
    }
  } finally {
    if (generation === pushGeneration) { pushState.busy = false; renderPushPanel(); }
  }
}

async function disablePush(forLogout = false) {
  if (!forLogout && (pushState.busy || !authenticated)) return;
  const generation = pushGeneration;
  if (!forLogout) { pushState.busy = true; pushState.message = ""; renderPushPanel(); }
  try {
    // Finish an in-flight renewal before removing its endpoint on logout.
    if (forLogout && pushLoadPromise) await pushLoadPromise;
    const registration = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration("/") : null;
    const subscription = pushState.subscription || await registration?.pushManager.getSubscription();
    if (subscription) {
      // Removing the server record happens before dropping the browser endpoint.
      try { await api("/api/doctor/push/unsubscribe", { endpoint: subscription.endpoint }, doctorCsrf); }
      finally {
        await subscription.unsubscribe();
        if (generation === pushGeneration) pushState.subscription = null;
      }
    }
    if (generation === pushGeneration) {
      pushState.subscription = null;
      pushRenewedEndpoint = "";
      pushState.message = "Bu cihaz için bildirimler kapatıldı.";
      pushState.tone = "success";
    }
  } catch (error) {
    if (!forLogout && generation === pushGeneration) {
      pushState.message = error.status ? error.message : "Bildirim bağlantısı tam kapatılamadı. Yeniden deneyin veya hekim oturumundan çıkış yapın.";
      pushState.tone = "error";
    }
  } finally {
    if (generation === pushGeneration) { pushState.busy = false; if (!forLogout) renderPushPanel(); }
  }
}

function doctorMarkup() {
  return `<section id="doctor-status" class="doctor-status-bar" aria-label="Talep kabul durumu"></section>
  <div class="doctor-toolbar"><h1>Revir talepleri</h1><button class="button button--small" type="button" data-action="refresh">Şimdi yenile</button></div>
  <section id="doctor-message-summary" class="card doctor-presence-summary" aria-label="Çalışan mesajları" hidden></section>
  <section id="doctor-presence-summary" class="card doctor-presence-summary" aria-label="Çalışanların bekleme durumu" hidden></section>
  <div id="doctor-message" class="form-message" role="status" aria-live="polite"></div>
  <section class="requests-column" aria-label="Revir talepleri"><div id="request-filters" class="filters" aria-label="Talep durumu filtreleri"></div><div id="doctor-requests" class="request-list"></div></section>
  <div class="doctor-settings-stack"><h2 class="doctor-settings-title">Bildirimler ve ayarlar</h2>
  <section id="doctor-push" class="card push-card" aria-labelledby="push-heading"></section>
  <details class="card card-details" id="settings-details"><summary>Revir durumu ve saatleri</summary><div class="details-body">
    <form id="settings-form">
      <section class="settings-section"><h3>Bugünkü revir durumu</h3><p class="helper">Buradaki özel saatler ve mesajlar gün sonunda sona erer.</p><div class="fields">
        <div class="field"><label for="today-mode">Bugünkü çalışma</label><select id="today-mode" name="todayMode"><option value="regular">Haftalık planı kullan</option><option value="open">Bugün açık</option><option value="closed">Bugün kapalı</option></select></div>
        <div class="form-columns"><div class="field"><label for="today-start">Başlangıç</label><input type="time" id="today-start" name="todayStart"></div><div class="field"><label for="today-end">Bitiş</label><input type="time" id="today-end" name="todayEnd"></div></div>
        <div class="field"><label for="today-message">Bugüne özel açıklama <span>· isteğe bağlı</span></label><input id="today-message" name="todayMessage" maxlength="160" placeholder="Örneğin: Bugün revir 13.00’te açılacak."></div>
        <div class="field"><label for="status-message">Durum mesajı <span>· bugünlük</span></label><textarea id="status-message" name="statusMessage" maxlength="160" placeholder="Örneğin: Kısa süreliğine saha turundayım."></textarea></div>
        <div class="field"><label for="return-minutes">Dönüş saati belirt</label><select id="return-minutes" name="returnMinutes"><option value="keep">Mevcut saati koru</option><option value="">Dönüş saatini kaldır</option><option value="15">15 dakika sonra</option><option value="30">30 dakika sonra</option><option value="60">1 saat sonra</option></select><span id="current-return" class="helper"></span><span class="helper">Kaydettiğiniz andaki saatten hesaplanır. Süre dolunca revir durumu kendiliğinden değişmez.</span></div>
      </div></section>
      <section class="settings-section"><h3>Haftalık çalışma saatleri</h3><p class="helper">Açık günleri işaretleyin; başlangıç ve bitiş saatlerini belirleyin.</p>${scheduleFormMarkup()}</section>
      <section class="settings-section"><h3>İletişim bilgileri</h3><div class="fields"><div class="field"><label for="work-phone">Revir iş telefonu <span>· isteğe bağlı</span></label><input type="tel" id="work-phone" name="workPhone" maxlength="30" placeholder="+90… veya 05… ile başlayan iş telefonu"><span class="helper">Çalışan sayfasında görünür. Dahili numarayla yalnız arama; +90… veya 05… numarayla arama ve WhatsApp bağlantısı gösterilir.</span></div><div class="field"><label for="emergency-text">Acil durum açıklaması <span>· isteğe bağlı</span></label><textarea id="emergency-text" name="emergencyText" maxlength="200" placeholder="İşyerinin acil yardım yöntemini buraya yazabilirsiniz."></textarea></div></div></section>
      <div id="settings-message" class="form-message" role="status" aria-live="polite"></div><div class="settings-save"><button class="button button--primary button--full" type="submit">Ayarları kaydet</button><p id="settings-dirty" class="helper">Değişiklikler Kaydet’e basınca yayınlanır.</p></div>
    </form></div></details>
  <details id="doctor-feedback-details" class="card card-details"><summary>Uygulama görüşleri ve hatalar</summary><div class="details-body"><p class="helper">Tıbbi taleplerden ayrıdır. Yeni görüşte telefonunuza içerik paylaşmadan bildirim gelir. Son 7 gündeki görüşleri buradan okuyabilirsiniz.</p><button id="doctor-feedback-load" class="button button--small" type="button" data-action="doctor-feedback-load">Görüşleri getir / yenile</button><div id="doctor-feedback-status" class="form-message" role="status"></div><div id="doctor-feedback-list"></div></div></details></div>`;
}

function renderDoctorStatus() {
  const availability = doctorState.availability;
  const paused = Boolean(doctorState.settings.pausedToday);
  const accepting = !paused && availability.accepting;
  if (doctorPauseNoticeDate && (doctorPauseNoticeDate !== doctorState.settings.formDate || (doctorPauseTone === "success" && doctorPauseNoticeState !== null && doctorPauseNoticeState !== paused))) doctorPauseMessage = "";
  const formBusy = document.getElementById("settings-form")?.dataset.busy === "true";
  document.getElementById("doctor-status").innerHTML = `<div class="doctor-status-row"><p class="doctor-status-label ${accepting ? "" : "is-closed"}"><span class="worker-status-dot" aria-hidden="true"></span>${accepting ? "Revir talep kabul ediyor" : paused ? "Bugün talep alımı kapalı" : "Şu anda talep alınmıyor"}</p><button id="doctor-pause-toggle" class="button button--small ${paused ? "button--soft" : ""}" type="button" data-action="doctor-toggle-pause" ${doctorPauseBusy || formBusy ? "disabled" : ""}>${doctorPauseBusy ? "Kaydediliyor…" : paused ? "Bugünkü kapatmayı kaldır" : "Bugün talep alımını kapat"}</button></div>
    <p class="helper doctor-status-detail">${paused ? "Bugünlük kapalı. Yarın haftalık saatleriniz geçerli olur." : escapeHtml(availability.detail || "")}</p>
    <div id="doctor-pause-message" class="form-message" role="status" aria-live="polite"></div>`;
  setMessage("doctor-pause-message", doctorPauseMessage, doctorPauseTone);
}

function hasNewerDoctorSettings(settings) {
  const current = doctorState.settings;
  return current.version > settings.version || current.formDate > settings.formDate;
}

async function toggleDoctorPause() {
  if (!authenticated || !doctorState || doctorPauseBusy || document.getElementById("settings-form")?.dataset.busy === "true") return;
  const previous = doctorState.settings;
  const csrf = doctorCsrf;
  const draftBasedOnCurrent = !settingsConflict && settingsVersion === previous.version && settingsDate === previous.formDate;
  const pauseToday = !previous.pausedToday;
  doctorPauseBusy = true;
  doctorPauseMessage = "";
  doctorPauseNoticeDate = previous.formDate;
  doctorPauseNoticeState = null;
  renderDoctorStatus();
  doctorEpoch++;
  try {
    const result = await api("/api/doctor/settings", { expectedVersion: previous.version, formDate: previous.formDate, pauseToday }, csrf);
    if (!authenticated || !doctorState || doctorCsrf !== csrf) return;
    if (hasNewerDoctorSettings(result.settings)) { await refreshDoctor(true); return; }
    doctorEpoch++;
    if (result.csrfToken) doctorCsrf = result.csrfToken;
    doctorState.settings = result.settings;
    doctorState.availability = { ...doctorState.availability, accepting: false, pausedToday: Boolean(result.settings.pausedToday),
      detail: result.settings.pausedToday ? "Bugün talep alımı hekim tarafından kapatıldı." : "Kayıtlı çalışma saatleriniz kontrol ediliyor." };
    if (result.settings.schedule) doctorState.schedule = result.settings.schedule;
    if (!settingsDirty) populateSettings(result.settings);
    else if (draftBasedOnCurrent) {
      // A pause does not change any form field. Keep unsaved edits while moving
      // their version forward only when they were based on the same snapshot.
      settingsVersion = result.settings.version;
      settingsDate = result.settings.formDate;
    }
    doctorPauseMessage = pauseToday ? "Bugün talep alımı kapatıldı. Yarın haftalık saatleriniz geçerli olur." : "Bugünkü kapatma kaldırıldı. Kayıtlı çalışma saatleriniz geçerli.";
    doctorPauseTone = "success";
    doctorPauseNoticeDate = result.settings.formDate;
    doctorPauseNoticeState = Boolean(result.settings.pausedToday);
    await refreshDoctor(true);
  } catch (error) {
    if (!authenticated || !doctorState || doctorCsrf !== csrf) return;
    doctorPauseMessage = error.status === 409 ? "Durum değişti; güncel bilgileri aldık. Kontrol edip yeniden dokunun." : error.message;
    doctorPauseTone = error.status === 409 ? "warning" : "error";
    if (error.status === 409) await refreshDoctor(true);
    else if (error.status === 401 || error.status === 403) await showDoctorLogin("Hekim oturumunuz sona erdi. Özel şifrenizle yeniden giriş yapın.");
  } finally {
    doctorPauseBusy = false;
    if (authenticated && doctorMounted && doctorState) renderDoctorStatus();
  }
}

function setField(form, name, value) {
  const field = form.elements.namedItem(name);
  if (!field) return;
  if (field.type === "checkbox") field.checked = Boolean(value);
  else field.value = value ?? "";
}

function populateSettings(settings) {
  const form = document.querySelector("#settings-form");
  if (!form || !settings) return;
  settingsVersion = settings.version;
  settingsDate = settings.formDate;
  settingsVisibleKey = JSON.stringify(settings);
  settingsDirty = false;
  settingsConflict = false;
  const today = settings.todayOverride;
  setField(form, "todayMode", today ? today.open ? "open" : "closed" : "regular");
  setField(form, "todayStart", today?.start || "08:00");
  setField(form, "todayEnd", today?.end || "17:00");
  setField(form, "todayMessage", today?.message || "");
  setField(form, "statusMessage", settings.statusMessage || "");
  setField(form, "returnMinutes", "keep");
  setField(form, "workPhone", settings.workPhone || "");
  setField(form, "emergencyText", settings.emergencyText || "");
  doctorState.schedule.forEach((row, index) => {
    setField(form, `day-${index}-open`, row.open);
    setField(form, `day-${index}-start`, row.start || "08:00");
    setField(form, `day-${index}-end`, row.end || "17:00");
  });
  document.querySelector("#current-return").textContent = settings.returnAt ? `Mevcut dönüş saati: ${clockText(settings.returnAt)}.` : "Dönüş saati belirtilmedi.";
  document.querySelector("#settings-dirty").textContent = "Değişiklikler Kaydet’e basınca yayınlanır.";
  updateSettingControls();
}

function updateSettingControls() {
  const form = document.querySelector("#settings-form");
  if (!form) return;
  const mode = form.elements.todayMode.value;
  form.elements.todayStart.disabled = mode !== "open";
  form.elements.todayEnd.disabled = mode !== "open";
  form.elements.todayMessage.disabled = mode === "regular";
  form.elements.todayStart.required = mode === "open";
  form.elements.todayEnd.required = mode === "open";
  for (let index = 0; index < 7; index++) {
    const open = form.elements.namedItem(`day-${index}-open`).checked;
    form.elements.namedItem(`day-${index}-start`).disabled = !open;
    form.elements.namedItem(`day-${index}-end`).disabled = !open;
  }
}

function answerMarkup(item) {
  if (!item.reply) return "";
  return `<div class="answer"><span class="eyebrow">Gönderilen yanıt</span><p>${escapeHtml(item.reply)}</p><small>${escapeHtml(dateText(item.repliedAt))}</small></div>`;
}

function draftFor(item) {
  if (!drafts.has(item.id)) drafts.set(item.id, { text: "", returnMinutes: null, version: item.version, conflict: false, message: "", tone: "error" });
  const draft = drafts.get(item.id);
  if (draft.text.trim() && draft.version !== item.version) draft.conflict = true;
  if (!draft.text.trim() && !draft.conflict) draft.version = item.version;
  return draft;
}

function doctorPresenceMarkup(item) {
  if (!item.reply) return "";
  return `<div class="doctor-presence ${validPresence(item) ? `is-${item.presence}` : "is-unknown"}"><strong>${escapeHtml(presenceLabel(item))}</strong>${validPresence(item) ? `<span>Son bildirim: ${escapeHtml(dateText(item.presenceUpdatedAt))}</span>` : ""}<small>${item.status === "done" ? "Talep tamamlandı; bu son bildirilen durumdur." : validPresence(item) ? "Çalışanın son beyanıdır; hâlâ orada olduğunu garanti etmez." : "Çalışan henüz bekleme seçimi yapmadı."}</small></div>`;
}

function renderDoctorPresenceSummary() {
  const answered = doctorState.requests.filter(item => item.status === "answered");
  const panel = document.getElementById("doctor-presence-summary");
  panel.hidden = !answered.length;
  if (!answered.length) return;
  const waiting = answered.filter(item => item.presence === "waiting");
  const left = answered.filter(item => item.presence === "left");
  const reported = answered.filter(validPresence).sort((a, b) => new Date(b.presenceUpdatedAt) - new Date(a.presenceUpdatedAt));
  updateWorkerHtml("doctor-presence-summary", `<h2>Çalışanların son bildirimi</h2><div class="doctor-presence-counts"><span class="presence-count is-waiting">Bekliyor <strong>${waiting.length}</strong></span><span class="presence-count is-left">Ayrıldı <strong>${left.length}</strong></span><span class="presence-count">Belirtmedi <strong>${answered.length - waiting.length - left.length}</strong></span></div>
    ${reported.length ? `<ul class="doctor-left-list">${reported.slice(0, 3).map(item => `<li class="is-${item.presence}"><span><strong>${escapeHtml(item.visitorCode || "Talep")}${item.fullName ? ` · ${escapeHtml(item.fullName)}` : ""}</strong><span>${escapeHtml(presenceLabel(item))} · ${escapeHtml(dateText(item.presenceUpdatedAt))}</span></span><button type="button" class="button button--small" data-action="doctor-presence-request" data-id="${escapeHtml(item.id)}">Talebi aç</button></li>`).join("")}</ul>` : ""}
    <button type="button" class="button button--small space-top" data-action="doctor-presence-list">Yanıtlanan talepleri gör</button><p class="helper space-top">Son bildirilen durumlardır. Seçim yapmayan çalışan bekliyor sayılmaz.</p>`);
}

function requestMarkup(item) {
  const draft = draftFor(item);
  const phone = phoneInfo(item.phone);
  const busy = busyRequests.has(item.id);
  return `<article id="doctor-request-${escapeHtml(item.id)}" tabindex="-1" class="doctor-request ${item.status === "new" ? "is-new" : item.status === "answered" ? "is-answered" : "is-done"}" data-request="${escapeHtml(item.id)}">
    <div class="item-heading"><div><h3 class="doctor-visitor-code">${escapeHtml(item.visitorCode || "Talep")}</h3><p class="request-meta">${escapeHtml(dateText(item.createdAt))}</p></div>${badge(item.status)}</div>
    <div class="person">${item.fullName ? `<strong>${escapeHtml(item.fullName)}</strong>` : ""}${item.phone ? phone ? `<a href="tel:${escapeHtml(phone.dial)}">${escapeHtml(item.phone)}</a>` : `<span>${escapeHtml(item.phone)}</span>` : '<span>İletişim numarası eklenmedi.</span>'}</div>
    ${item.note ? `<p class="request-text"><span class="doctor-note-label">Çalışanın notu</span>${escapeHtml(item.note)}</p>` : '<p class="helper">Kısa not eklenmedi.</p>'}
    ${requestMessagesMarkup(item)}
    ${answerMarkup(item)}
    ${doctorPresenceMarkup(item)}
    ${draft.conflict ? `<div class="notice notice--warning space-top"><p>Talep başka bir ekranda değişti. Yazdığınız yanıt korunuyor. Güncel kaydı okuyup yeniden gönderebilirsiniz.</p><div class="actions"><button class="button button--small" type="button" data-action="request-current" data-id="${escapeHtml(item.id)}">Güncel durumu al</button></div></div>` : ""}
    ${draft.message ? `<div class="notice notice--${escapeHtml(draft.tone)} space-top" role="status">${escapeHtml(draft.message)}</div>` : ""}
    ${item.status !== "done" ? `<form class="answer-form" data-id="${escapeHtml(item.id)}"><div class="field"><label for="reply-${escapeHtml(item.id)}">${item.status === "answered" ? "Yeni yanıt gönder" : "Talebi yanıtla"}</label><textarea id="reply-${escapeHtml(item.id)}" name="reply" maxlength="300" placeholder="Çalışana iletmek istediğiniz kısa yanıt" ${busy ? "disabled" : ""}>${escapeHtml(draft.text)}</textarea></div>
    <div class="quick-replies" aria-label="Hazır yanıtlar"><button type="button" class="button button--small button--soft" data-action="quick-text" data-id="${escapeHtml(item.id)}" data-text="Geliyorum, lütfen revir önünde bekleyin." ${busy ? "disabled" : ""}>Geliyorum, bekleyin</button><button type="button" class="button button--small button--soft" data-action="quick-text" data-id="${escapeHtml(item.id)}" data-text="Yemek molasındayım. Molam bitince revirde olacağım. Yanıtımı bu sayfadan takip edebilirsiniz." ${busy ? "disabled" : ""}>Yemek molasındayım</button><button type="button" class="button button--small button--soft" data-action="quick-text" data-id="${escapeHtml(item.id)}" data-text="Revirdeyim, gelebilirsiniz." ${busy ? "disabled" : ""}>Revirdeyim</button>${[15, 30, 60].map(minutes => `<button type="button" class="button button--small button--soft" data-action="quick-time" data-id="${escapeHtml(item.id)}" data-minutes="${minutes}" aria-pressed="${draft.returnMinutes === minutes}" ${busy || draft.conflict ? "disabled" : ""}>${minutes === 60 ? "1 saat" : `${minutes} dakika`} sonra</button>`).join("")}</div><p class="helper">Hazır yanıtı seçip Yanıtı gönder’e basın. Dönüş saati gönderdiğiniz anda hesaplanır.</p>
    <div class="actions"><button type="submit" class="button button--primary" ${busy || draft.conflict ? "disabled" : ""}>${busy ? "Kaydediliyor…" : "Yanıtı gönder"}</button><button type="button" class="button" data-action="complete" data-id="${escapeHtml(item.id)}" ${busy || draft.conflict ? "disabled" : ""}>Tamamlandı olarak işaretle</button></div></form>` : `<div class="actions space-top"><button type="button" class="button button--small" data-action="reopen" data-id="${escapeHtml(item.id)}" ${busy ? "disabled" : ""}>Tamamlamayı geri al</button><span class="helper">${escapeHtml(dateText(item.completedAt))}</span></div>`}
    <p class="request-meta space-top">Görüntüleme süresi sonu: ${escapeHtml(dateText(item.expiresAt))}</p>
  </article>`;
}

function renderDoctorRequests(force = false) {
  const requests = doctorState.requests;
  const counts = { new: 0, answered: 0, done: 0 };
  requests.forEach(item => { if (item.status in counts) counts[item.status]++; });
  document.querySelector("#request-filters").innerHTML = Object.keys(counts).map(status => `<button class="filter" type="button" data-action="filter" data-filter="${status}" aria-pressed="${filter === status}">${statuses[status]}<span>${counts[status]}</span></button>`).join("");
  const fingerprint = JSON.stringify([filter, requests, [...busyRequests]]);
  if (!force && fingerprint === requestsFingerprint) return;
  requestsFingerprint = fingerprint;
  const active = document.activeElement;
  const focusedReply = active?.matches(".answer-form textarea") ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const scroll = window.scrollY;
  const shown = requests.filter(item => item.status === filter).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  document.querySelector("#doctor-requests").innerHTML = shown.length ? shown.map(requestMarkup).join("") : `<div class="card empty-state"><h3>${filter === "new" ? "Yeni talep yok." : filter === "answered" ? "Yanıtlanmış talep yok." : "Tamamlanan talep yok."}</h3><p>${filter === "new" ? "Çalışanlar talep ilettiğinde bu bölümde görünecek." : "Bu durumdaki talepler burada listelenir."}</p></div>`;
  if (focusedReply) {
    const textarea = document.getElementById(focusedReply.id);
    if (textarea) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(focusedReply.start, focusedReply.end);
      window.scrollTo({ top: scroll, behavior: "instant" });
    }
  }
  const retained = new Set(requests.map(item => item.id));
  for (const id of drafts.keys()) if (!retained.has(id)) drafts.delete(id);
}

function renderDoctor() {
  if (!doctorState) return;
  if (!doctorMounted) {
    loginMounted = false;
    app.innerHTML = doctorMarkup();
    doctorMounted = true;
    void loadPushPanel();
    populateSettings(doctorState.settings);
    document.querySelector("#header-actions").innerHTML = `${doctorEmail ? `<span class="doctor-identity" title="${escapeHtml(doctorEmail)}">${escapeHtml(doctorEmail)}</span>` : ""}<a class="header-link" href="/" target="_blank" rel="noopener">Çalışan sayfası</a><button class="button button--small" type="button" data-action="logout">Çıkış</button>`;
  } else if (!settingsDirty) {
    const form = document.querySelector("#settings-form");
    if (form.dataset.busy !== "true" && settingsVisibleKey !== JSON.stringify(doctorState.settings)) populateSettings(doctorState.settings);
  } else if ((settingsVersion !== doctorState.settings.version || settingsDate !== doctorState.settings.formDate) && !settingsConflict) {
    settingsConflict = true;
    setMessage("settings-message", settingsDate !== doctorState.settings.formDate ? "Gün değişti; bugünkü ayarlar yeniden kontrol edilmeli. Yazdıklarınız korunuyor. Güncel ayarları alıp değişikliklerinizi yeniden uygulayın." : "Ayarlar başka bir ekranda değişti. Yazdıklarınız korunuyor. Güncel ayarları alıp değişikliklerinizi yeniden uygulayın.", "warning", '<div class="actions"><button type="button" class="button button--small" data-action="settings-current">Güncel ayarları al</button></div>');
  }
  renderDoctorStatus();
  renderDoctorPresenceSummary();
  renderDoctorMessageSummary();
  renderDoctorRequests();
  openDoctorFeedbackTarget();
}

function refreshDoctor(waitForFresh = false) {
  if (!authenticated) return Promise.resolve();
  if (doctorReadPromise) return waitForFresh ? doctorReadPromise.then(() => refreshDoctor()) : doctorReadPromise;
  const epoch = doctorEpoch;
  doctorReadPromise = (async () => {
    try {
      const state = await api("/api/doctor/state");
      if (epoch !== doctorEpoch) return;
      doctorState = state;
      if (doctorState.csrfToken) doctorCsrf = doctorState.csrfToken;
      renderDoctor();
    } catch (error) {
      if (epoch !== doctorEpoch) return;
      if (error.status === 401 || error.status === 403) {
        await showDoctorLogin("Hekim oturumunuz sona erdi. Özel şifrenizle yeniden giriş yapın.");
      } else {
        connectionError = error.message;
        renderConnection();
        if (!doctorMounted) app.innerHTML = `<div class="card loading"><h1>Hekim ekranı yüklenemedi.</h1><p class="muted">${escapeHtml(error.message)}</p><button class="button button--primary" type="button" data-action="refresh">Tekrar dene</button></div>`;
      }
    } finally { doctorReadPromise = null; }
  })();
  return doctorReadPromise;
}

async function loadDoctorSession(show = true, message = "") {
  const epoch = doctorEpoch;
  try {
    const session = await readDoctorSession();
    if (epoch !== doctorEpoch) return;
    doctorCsrf = session.csrfToken || "";
    doctorEmail = session.email || "";
    authenticated = Boolean(session.authenticated);
    if (authenticated) await refreshDoctor();
    else if (show) renderLogin(message, doctorCsrf);
  } catch (error) {
    if (epoch !== doctorEpoch) return;
    connectionError = error.message;
    if (show) renderLogin(error.message, "");
    renderConnection();
  }
}

async function submitLogin(form) {
  if (form.dataset.busy === "true") return;
  setMessage("login-message", "");
  setFormBusy(form, true, "Giriş yapılıyor…");
  doctorEpoch++;
  try {
    if (!doctorCsrf) {
      const session = await readDoctorSession();
      doctorCsrf = session.csrfToken || "";
      if (session.authenticated) {
        doctorEpoch++;
        doctorEmail = session.email || "";
        authenticated = true;
        form.elements.password.value = "";
        await refreshDoctor(true);
        return;
      }
    }
    const result = await api("/api/doctor/login", { password: form.elements.password.value }, doctorCsrf);
    doctorEpoch++;
    doctorCsrf = result.csrfToken || "";
    doctorEmail = result.email || "";
    authenticated = Boolean(result.authenticated);
    if (!authenticated) throw new Error("Giriş doğrulanamadı. Lütfen tekrar deneyin.");
    form.elements.password.value = "";
    await refreshDoctor(true);
  } catch (error) {
    setMessage("login-message", error.message);
    if (error.status === 403 || (error.status === 401 && error.code === "SESSION_EXPIRED")) {
      // A rotated/expired pre-login session must be refreshed, then the user can retry.
      // Do not resend a password automatically or replace the form they are typing in.
      try {
        const session = await readDoctorSession();
        doctorCsrf = session.csrfToken || "";
        if (session.authenticated) {
          doctorEpoch++;
          doctorEmail = session.email || "";
          authenticated = true;
          form.elements.password.value = "";
          await refreshDoctor(true);
        }
      } catch { doctorCsrf = ""; }
    }
  } finally { setFormBusy(form, false); }
}

function settingsBody(form) {
  const value = name => form.elements.namedItem(name).value;
  const mode = value("todayMode");
  const body = {
    expectedVersion: settingsVersion,
    formDate: settingsDate,
    schedule: Array.from({ length: 7 }, (_, index) => ({ open: form.elements.namedItem(`day-${index}-open`).checked, start: value(`day-${index}-start`), end: value(`day-${index}-end`) })),
    todayOverride: mode === "regular" ? null : { open: mode === "open", start: value("todayStart"), end: value("todayEnd"), message: value("todayMessage") },
    statusMessage: value("statusMessage"),
    workPhone: value("workPhone"),
    emergencyText: value("emergencyText")
  };
  if (value("returnMinutes") !== "keep") body.returnMinutes = value("returnMinutes") ? Number(value("returnMinutes")) : null;
  return body;
}

async function submitSettings(form) {
  if (form.dataset.busy === "true" || doctorPauseBusy || !authenticated || !doctorState) return;
  if (settingsConflict) {
    setMessage("settings-message", "Ayarlar değiştiği için kaydedilmedi. Güncel ayarları alıp değişikliklerinizi yeniden uygulayın.", "warning", '<div class="actions"><button type="button" class="button button--small" data-action="settings-current">Güncel ayarları al</button></div>');
    return;
  }
  const csrf = doctorCsrf;
  setMessage("settings-message", "");
  setFormBusy(form, true);
  renderDoctorStatus();
  doctorEpoch++;
  try {
    const result = await api("/api/doctor/settings", settingsBody(form), csrf);
    if (!authenticated || !doctorState || doctorCsrf !== csrf) return;
    if (hasNewerDoctorSettings(result.settings)) { await refreshDoctor(true); return; }
    doctorEpoch++;
    if (result.csrfToken) doctorCsrf = result.csrfToken;
    doctorState.settings = result.settings;
    // The saved hours may close or reopen the clinic. Do not keep displaying
    // the previous accepting state if the following state read is unavailable.
    doctorState.availability = { ...doctorState.availability, accepting: false, pausedToday: Boolean(result.settings.pausedToday),
      detail: result.settings.pausedToday ? "Bugün talep alımı hekim tarafından kapatıldı." : "Kayıtlı çalışma saatleriniz kontrol ediliyor." };
    if (result.settings.schedule) doctorState.schedule = result.settings.schedule;
    settingsDirty = false;
    settingsVersion = result.settings.version;
    populateSettings(result.settings);
    setMessage("settings-message", "Revir ayarları kaydedildi. Çalışan sayfasında görünür.", "success");
    await refreshDoctor(true);
  } catch (error) {
    if (!authenticated || !doctorState || doctorCsrf !== csrf) return;
    if (error.status === 409) {
      settingsConflict = true;
      setMessage("settings-message", error.message, "warning", '<div class="actions"><button type="button" class="button button--small" data-action="settings-current">Güncel ayarları al</button></div>');
      await refreshDoctor(true);
    } else if (error.status === 401 || error.status === 403) {
      await showDoctorLogin("Hekim oturumunuz sona erdi. Özel şifrenizle yeniden giriş yapın.");
    } else setMessage("settings-message", error.message);
  } finally {
    setFormBusy(form, false);
    if (authenticated && doctorMounted && doctorState) renderDoctorStatus();
  }
}

function requestById(id) { return doctorState?.requests.find(item => item.id === id); }

async function mutateRequest(id, action) {
  const item = requestById(id);
  if (!authenticated || !item || busyRequests.has(id)) return;
  const csrf = doctorCsrf;
  const draft = draftFor(item);
  if (draft.conflict && action !== "reopen") return;
  if (action === "answer" && draft.returnMinutes === null && !draft.text.trim()) {
    draft.message = "Göndermek istediğiniz yanıtı yazın veya hazır bir yanıt seçin.";
    draft.tone = "warning";
    renderDoctorRequests(true);
    document.getElementById(`reply-${id}`)?.focus();
    return;
  }
  const expectedVersion = action === "answer" ? draft.version : item.version;
  const body = action === "answer" ? { text: draft.text, returnMinutes: draft.returnMinutes, expectedVersion } : { expectedVersion };
  busyRequests.add(id);
  draft.message = "";
  renderDoctorRequests(true);
  doctorEpoch++;
  try {
    const result = await api(`/api/doctor/requests/${encodeURIComponent(id)}/${action}`, body, csrf);
    if (!authenticated || !doctorState || doctorCsrf !== csrf) return;
    doctorEpoch++;
    if (result.csrfToken) doctorCsrf = result.csrfToken;
    drafts.delete(id);
    if (result.request) doctorState.requests = doctorState.requests.map(record => record.id === id && result.request.version >= record.version ? result.request : record);
    if (action === "complete") {
      setMessage("doctor-message", "Talep tamamlandı. Yanlışlıkla tamamladıysanız geri alabilirsiniz.", "success", `<div class="actions"><button class="button button--small" type="button" data-action="reopen" data-id="${escapeHtml(id)}">Tamamlamayı geri al</button></div>`);
    } else if (action === "reopen") {
      filter = result.request?.status === "answered" ? "answered" : "new";
      setMessage("doctor-message", "Tamamlama geri alındı. Talep önceki durumuna döndü; gönderilen yanıt korunur.", "success");
    } else {
      setMessage("doctor-message", "Yanıt gönderildi. Çalışan kendi sayfasından görebilir.", "success");
    }
    await refreshDoctor(true);
  } catch (error) {
    if (!authenticated || !doctorState || doctorCsrf !== csrf) return;
    draft.message = error.message;
    draft.tone = error.status === 409 ? "warning" : "error";
    if (error.status === 409) { draft.conflict = true; await refreshDoctor(true); }
    else if (error.status === 401 || error.status === 403) { await showDoctorLogin("Hekim oturumunuz sona erdi. Özel şifrenizle yeniden giriş yapın."); }
  } finally {
    busyRequests.delete(id);
    if (doctorMounted && doctorState) renderDoctorRequests(true);
  }
}

async function refresh(waitForFresh = false) {
  if (isDoctor) {
    if (authenticated) await refreshDoctor(waitForFresh);
    else await loadDoctorSession();
  } else await refreshPublic(waitForFresh);
}

document.addEventListener("submit", event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id === "request-form") { event.preventDefault(); void submitRequest(form); }
  else if (form.id === "worker-message-form") { event.preventDefault(); void submitWorkerMessage(); }
  else if (form.id === "worker-feedback-form") { event.preventDefault(); void submitWorkerFeedback(); }
  else if (form.id === "login-form") { event.preventDefault(); void submitLogin(form); }
  else if (form.id === "settings-form") { event.preventDefault(); void submitSettings(form); }
  else if (form.matches(".answer-form")) { event.preventDefault(); void mutateRequest(form.dataset.id, "answer"); }
});

document.addEventListener("input", event => {
  const field = event.target;
  if (!(field instanceof HTMLElement)) return;
  if (["worker-message-text", "worker-message-name", "worker-message-phone"].includes(field.id)) rememberWorkerMessageDraft();
  if (field.id === "request-note") document.querySelector("#note-count").textContent = `${field.value.length} / 300`;
  if (field.closest("#settings-form")) {
    settingsDirty = true;
    document.querySelector("#settings-dirty").textContent = "Kaydedilmemiş değişiklikleriniz var.";
    updateSettingControls();
  }
  const form = field.closest(".answer-form");
  if (form && field.matches("textarea")) {
    const item = requestById(form.dataset.id);
    if (item) { const draft = draftFor(item); draft.text = field.value; draft.returnMinutes = null; draft.message = ""; }
  }
});

document.addEventListener("change", event => {
  if (event.target instanceof HTMLElement && event.target.closest("#settings-form")) {
    settingsDirty = true;
    document.querySelector("#settings-dirty").textContent = "Kaydedilmemiş değişiklikleriniz var.";
    updateSettingControls();
  }
});

document.addEventListener("click", async event => {
  const button = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "refresh") { await refresh(true); }
  else if (action === "worker-new-request" && !isDoctor && publicState?.availability.accepting) {
    if (publicState.requests.some(item => item.status === "new" || item.status === "answered")) openWorkerForm();
    else await submitRequest(document.getElementById("request-form"));
  }
  else if (action === "worker-cancel-request" && !isDoctor) { workerFormOpen = false; renderWorker(); focusWorkerResult(); }
  else if (action === "worker-select" && !isDoctor) { selectWorkerRequest(id); }
  else if (action === "worker-ack" && !isDoctor) { acknowledgeWorkerReply(id); }
  else if (action === "worker-presence" && !isDoctor) { await submitWorkerPresence(id, button.dataset.presence); }
  else if (action === "worker-latest-reply" && !isDoctor) {
    const latest = publicState?.requests.filter(item => item.reply && !workerReplySeen(item)).sort((a, b) => new Date(b.repliedAt || b.createdAt) - new Date(a.repliedAt || a.createdAt))[0];
    if (latest) selectWorkerRequest(latest.id);
  }
  else if (action === "filter" && doctorState) { filter = button.dataset.filter; renderDoctorRequests(true); }
  else if ((action === "doctor-presence-list" || action === "doctor-presence-request") && doctorState) {
    filter = "answered";
    renderDoctorRequests(true);
    const target = action === "doctor-presence-request" ? document.getElementById(`doctor-request-${id}`) : document.getElementById("request-filters");
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start", behavior: "auto" }); }
  }
  else if (action === "doctor-message-request" && doctorState) {
    const item = requestById(id);
    if (item) { filter = item.status; renderDoctorRequests(true); const target = document.getElementById(`doctor-request-${id}`); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "start", behavior: "auto" }); }
  }
  else if (action === "doctor-feedback-load") { await loadDoctorFeedback(); }
  else if (action === "doctor-toggle-pause") { await toggleDoctorPause(); }
  else if (action === "logout") {
    button.disabled = true;
    doctorEpoch++;
    pushGeneration++;
    try {
      await disablePush(true);
      await api("/api/doctor/logout", {}, doctorCsrf);
      doctorEpoch++;
      renderLogin("Hekim oturumu kapatıldı.", "");
      await loadDoctorSession(true, "Hekim oturumu kapatıldı.");
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        await showDoctorLogin("Hekim oturumu kapalı. Yeniden giriş yapabilirsiniz.");
      } else {
        setMessage("doctor-message", error.message);
        button.disabled = false;
      }
    }
  } else if (action === "push-enable") { await enablePush(); }
  else if (action === "push-test") { await testPush(); }
  else if (action === "push-disable") { await disablePush(); }
  else if (action === "push-reload") { await loadPushPanel(); }
  else if (action === "quick-text") {
    const item = requestById(id);
    if (item) { const draft = draftFor(item); draft.text = button.dataset.text; draft.returnMinutes = null; draft.message = ""; renderDoctorRequests(true); document.getElementById(`reply-${id}`)?.focus(); }
  } else if (action === "quick-time") {
    const item = requestById(id);
    if (item) { const draft = draftFor(item); draft.returnMinutes = Number(button.dataset.minutes); draft.text = `${draft.returnMinutes === 60 ? "1 saat" : `${draft.returnMinutes} dakika`} sonra döneceğim.`; draft.message = ""; renderDoctorRequests(true); document.getElementById(`reply-${id}`)?.focus(); }
  }
  else if (action === "complete" || action === "reopen") { await mutateRequest(id, action); }
  else if (action === "request-current") {
    await refreshDoctor(true);
    const item = requestById(id);
    if (item) { const draft = draftFor(item); draft.version = item.version; draft.conflict = false; draft.message = "Güncel durum alındı. Yanıtınızı kontrol edip gönderebilirsiniz."; draft.tone = "success"; renderDoctorRequests(true); }
  } else if (action === "settings-current") {
    if (settingsDirty && !window.confirm("Güncel ayarları almak, bu formdaki kaydedilmemiş değişikliklerin yerine geçer. Devam edilsin mi?")) return;
    await refreshDoctor(true);
    if (doctorState) { populateSettings(doctorState.settings); setMessage("settings-message", "Güncel ayarlar alındı. Değişikliklerinizi yeniden uygulayabilirsiniz.", "success"); }
  }
});

document.addEventListener("visibilitychange", () => {
  renderConnection();
  if (!document.hidden && navigator.onLine) void refresh(true);
});
window.addEventListener("online", () => { renderConnection(); if (!document.hidden) void refresh(true); });
window.addEventListener("offline", renderConnection);
window.addEventListener("hashchange", () => { doctorFeedbackHashHandled = false; openDoctorFeedbackTarget(); });
navigator.serviceWorker?.addEventListener("message", event => {
  if (isDoctor && event.data?.type === "revir-open-feedback") openDoctorFeedbackTarget(true);
});
window.addEventListener("beforeunload", event => {
  if (settingsDirty || [...drafts.values()].some(draft => draft.text.trim()) || [...workerMessageDrafts.values()].some(draft => Object.values(draft).some(value => value.trim())) || document.getElementById("worker-feedback-text")?.value.trim()) { event.preventDefault(); event.returnValue = ""; }
});

if (isDoctor) {
  document.body.classList.add("doctor-view");
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/manifest.webmanifest";
  document.head.append(manifest);
  const appleTitle = document.createElement("meta");
  appleTitle.name = "apple-mobile-web-app-title";
  appleTitle.content = "Revir Hekim";
  document.head.append(appleTitle);
  document.title = "Hekim Ekranı · Revir Haberleşme";
  document.querySelector("#footer-link").textContent = "Çalışan sayfası";
  document.querySelector("#footer-link").href = "/";
  void loadDoctorSession();
} else {
  document.body.classList.add("worker-view");
  document.querySelector("#header-actions").innerHTML = "";
  app.innerHTML = `<div class="worker-page">${app.innerHTML}${contactsMarkup()}${emergencyMarkup()}</div>`;
  void refreshPublic();
}
setInterval(() => { if (!document.hidden && navigator.onLine && (!isDoctor || authenticated)) void refresh(); }, 10000);
