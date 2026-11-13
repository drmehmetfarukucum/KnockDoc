import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Exercise the shipped functions without starting its page-load requests/timer.
const functionsOnly = source.slice(0, source.lastIndexOf('\nif (isDoctor) {'));

function harness(path = '/') {
  const elements = new Map();
  const listeners = new Map();
  const storage = new Map();
  const redirects = [];
  const focusEvents = [];
  const scrollEvents = [];
  const clock = { now: Date.now() };
  class TestDate extends Date { static now() { return clock.now; } }
  class Element {
    constructor(id = '') {
      this.id = id;
      this.dataset = {};
      this.innerHTML = '';
      this.textContent = '';
      this.className = '';
      this.disabled = false;
      this.value = '';
      this.hidden = false;
      this.open = false;
      this.attributes = new Map();
      const classes = new Set();
      this.classList = {
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
      };
    }
    matches() { return false; }
    querySelectorAll() { return []; }
    querySelector(selector) { return selector.startsWith('#') ? element(selector.slice(1)) : element(`${this.id}-submit`); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    contains(target) { return target === this; }
    closest() { return null; }
    focus() { context.document.activeElement = this; focusEvents.push(this.id); }
    scrollIntoView(options) { scrollEvents.push({ id: this.id, options }); }
  }
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const context = vm.createContext({
    location: { pathname: path }, navigator: { onLine: true, serviceWorker: {
      addEventListener: (name, handler) => listeners.set(`serviceworker:${name}`, handler),
    } },
    document: {
      hidden: false, activeElement: null,
      body: element('body'),
      querySelector: selector => element(selector.replace(/^#/, '')),
      getElementById: element,
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    window: { scrollY: 0, scrollTo(...args) { scrollEvents.push({ window: args }); }, addEventListener() {}, confirm: () => true,
      location: { assign: url => redirects.push(url) } },
    Element, HTMLElement: Element, HTMLFormElement: Element,
    FormData: class { constructor(form) { this.values = form.values; } get(name) { return this.values[name] || ''; } },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    crypto: webcrypto, AbortController, Date: TestDate, Intl, Map, Set, Uint8Array, atob, btoa,
    setTimeout, clearTimeout,
    fetch: async () => { throw new Error('Unexpected request'); },
  });
  vm.runInContext(functionsOnly, context, { filename: 'public/app.js' });
  return { context, elements, element, listeners, storage, redirects, focusEvents, scrollEvents, advance: ms => { clock.now += ms; },
    run: code => vm.runInContext(code, context),
    async call(code) { return await vm.runInContext(code, context); },
  };
}

const publicFixture = {
  formDate: '2026-10-05', csrfToken: 'worker-csrf', requests: [], activeRequestId: null,
  availability: { accepting: true, headline: 'Revir açık' }, schedule: [], contacts: {},
};

function employeeRequest(id, values = {}) {
  return {
    id, status: 'new', note: '', version: 1,
    createdAt: '2026-10-05T06:00:00Z', expiresAt: '2026-10-12T06:00:00Z',
    reply: '', repliedAt: null, ...values,
    replyVersion: values.replyVersion ?? (values.reply ? 2 : 0),
    presence: values.presence ?? null, presenceUpdatedAt: values.presenceUpdatedAt ?? null,
  };
}

function renderEmployee(h, requests = [], overrides = {}) {
  h.context.fixture = { ...publicFixture, requests, ...overrides };
  h.run('publicState = fixture; renderWorker()');
}

function loginForm(h, password = 'Example-only-strong-password!') {
  const form = h.element('login-form');
  const field = h.element('doctor-password');
  field.value = password;
  form.elements = { password: field };
  form.querySelectorAll = () => [field];
  h.context.testForm = form;
  return { form, field };
}

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function requestForm(h, values = {}) {
  const form = h.element('request-form');
  form.values = { note: '', phone: '', fullName: '', ...values };
  form.resetCount = 0;
  form.reset = () => {
    form.values = { note: '', phone: '', fullName: '' };
    form.resetCount++;
  };
  h.context.testForm = form;
  return form;
}

function doctorSettingsHarness({ pausedToday = false, dirty = false, draftVersion = 7, draftDate = '2026-10-17' } = {}) {
  const h = harness('/doktor');
  const form = h.element('settings-form');
  const names = ['todayMode', 'todayStart', 'todayEnd', 'todayMessage', 'statusMessage', 'returnMinutes', 'workPhone', 'emergencyText'];
  for (let day = 0; day < 7; day++) names.push(`day-${day}-open`, `day-${day}-start`, `day-${day}-end`);
  const fields = Object.fromEntries(names.map(name => {
    const field = h.element(`setting-${name}`);
    field.type = name.endsWith('-open') ? 'checkbox' : 'text';
    return [name, field];
  }));
  fields.namedItem = name => fields[name];
  form.elements = fields;
  const schedule = Array.from({ length: 7 }, () => ({ open: true, start: '08:00', end: '17:00' }));
  h.context.fixture = {
    settings: { version: 7, formDate: '2026-10-17', pausedToday, statusMessage: 'Kayıtlı hekim notu', schedule },
    availability: { accepting: !pausedToday, detail: 'Çalışma saatleri' }, schedule, requests: [],
  };
  h.run('authenticated = true; doctorMounted = true; doctorCsrf = "doctor-csrf"; doctorState = fixture; populateSettings(doctorState.settings); let actualRefreshDoctor = refreshDoctor; let refreshes = 0; refreshDoctor = async () => { refreshes++; };');
  h.context.draftVersion = draftVersion;
  h.context.draftDate = draftDate;
  h.context.dirty = dirty;
  h.run('settingsDirty = dirty; settingsVersion = draftVersion; settingsDate = draftDate;');
  const button = h.element('doctor-pause-toggle');
  button.dataset.action = 'doctor-toggle-pause';
  button.closest = () => button;
  return { ...h, form, fields, button };
}

test('anonymous doctor bootstrap preserves pre-login CSRF and renders a private password form', async () => {
  const h = harness('/doktor');
  h.context.fetch = async path => {
    assert.equal(path, '/api/doctor/session');
    return jsonResponse({ authenticated: false, csrfToken: 'pre-login-csrf' });
  };
  await h.call('loadDoctorSession()');
  assert.equal(h.run('authenticated'), false);
  assert.equal(h.run('doctorCsrf'), 'pre-login-csrf');
  assert.match(h.element('app').innerHTML, /id="login-form"/);
  assert.match(h.element('app').innerHTML, /type="password" autocomplete="current-password"/);
  assert.doesNotMatch(h.element('app').innerHTML, /minlength="6"|\b[0-9]{6}\b|cdn-cgi|Hekim girişini aç/);
  h.run('renderLogin("Tekrar deneyin")');
  assert.equal(h.run('doctorCsrf'), 'pre-login-csrf');
});

test('password login sends pre-login CSRF, adopts rotated CSRF, clears only a successful password, and opens requests', async () => {
  const h = harness('/doktor');
  const { form, field } = loginForm(h);
  const original = field.value;
  const calls = [];
  h.context.fetch = async (path, options) => {
    calls.push(path);
    assert.equal(options.redirect, 'error');
    if (path.endsWith('/session')) return jsonResponse({ authenticated: false, csrfToken: 'pre-login-csrf' });
    assert.equal(path, '/api/doctor/login');
    assert.equal(options.headers['X-CSRF-Token'], 'pre-login-csrf');
    assert.equal(JSON.parse(options.body).password, original);
    assert.equal(field.disabled, true);
    return jsonResponse({ authenticated: true, csrfToken: 'rotated-doctor-csrf', email: 'doctor@example.com' });
  };
  h.run('let stateRefreshes = 0; refreshDoctor = async () => { stateRefreshes++; };');
  await h.call('submitLogin(testForm)');
  assert.deepEqual(calls, ['/api/doctor/session', '/api/doctor/login']);
  assert.equal(h.run('doctorCsrf'), 'rotated-doctor-csrf');
  assert.equal(h.run('authenticated'), true);
  assert.equal(h.run('doctorEmail'), 'doctor@example.com');
  assert.equal(h.run('stateRefreshes'), 1);
  assert.equal(field.value, '');
  assert.equal(form.dataset.busy, 'false');
  assert.equal(field.disabled, false);
});

test('failed or rate-limited password login keeps the typed password and pre-login CSRF without automatic retry', async () => {
  for (const status of [401, 429]) {
    const h = harness('/doktor');
    const { form, field } = loginForm(h, 'Keep-this-typed-password!');
    const calls = [];
    h.run('doctorCsrf = "pre-login-csrf"; renderLogin();');
    const page = h.element('app').innerHTML;
    h.context.fetch = async path => {
      calls.push(path);
      return jsonResponse({ error: { code: status === 401 ? 'LOGIN_FAILED' : 'RATE_LIMIT', message: status === 401 ? 'Giriş doğrulanamadı.' : 'Bir süre bekleyip tekrar deneyin.' } }, status);
    };
    await h.call('submitLogin(testForm)');
    assert.deepEqual(calls, ['/api/doctor/login']);
    assert.equal(field.value, 'Keep-this-typed-password!');
    assert.equal(h.run('doctorCsrf'), 'pre-login-csrf');
    assert.equal(h.run('authenticated'), false);
    assert.equal(h.element('app').innerHTML, page);
    assert.match(h.element('login-message').innerHTML, status === 401 ? /Giriş doğrulanamadı/ : /Bir süre bekleyip/);
    assert.equal(form.dataset.busy, 'false');
  }
});

test('expired login CSRF refreshes once and retains the password for a user initiated retry', async () => {
  const h = harness('/doktor');
  const { field } = loginForm(h, 'Still-in-the-form!');
  h.run('doctorCsrf = "stale-pre-login"; renderLogin();');
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    if (path.endsWith('/login')) return jsonResponse({ error: { code: 'CSRF', message: 'Oturumu yenileyip tekrar deneyin.' } }, 403);
    return jsonResponse({ authenticated: false, csrfToken: 'fresh-pre-login' });
  };
  await h.call('submitLogin(testForm)');
  assert.deepEqual(calls, ['/api/doctor/login', '/api/doctor/session']);
  assert.equal(h.run('doctorCsrf'), 'fresh-pre-login');
  assert.equal(field.value, 'Still-in-the-form!');
  assert.equal(h.run('authenticated'), false);
});

test('expired pre-login cookie refreshes once on SESSION_EXPIRED while a wrong password does not resend', async () => {
  const h = harness('/doktor');
  const { field } = loginForm(h, 'Keep-after-expiry!');
  h.run('doctorCsrf = "expired-pre-login"; renderLogin();');
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    if (path.endsWith('/login')) return jsonResponse({ error: { code: 'SESSION_EXPIRED', message: 'Oturumu yenileyip tekrar deneyin.' } }, 401);
    return jsonResponse({ authenticated: false, csrfToken: 'fresh-pre-login' });
  };
  await h.call('submitLogin(testForm)');
  assert.deepEqual(calls, ['/api/doctor/login', '/api/doctor/session']);
  assert.equal(h.run('doctorCsrf'), 'fresh-pre-login');
  assert.equal(field.value, 'Keep-after-expiry!');
  assert.equal(h.run('authenticated'), false);
});

test('login bootstrap reuses a valid session established by another tab without posting a password', async () => {
  const h = harness('/doktor');
  const { field } = loginForm(h, 'Need-not-send-this!');
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    assert.equal(path, '/api/doctor/session');
    return jsonResponse({ authenticated: true, csrfToken: 'existing-session-csrf', email: 'doctor@example.com' });
  };
  h.run('let stateRefreshes = 0; refreshDoctor = async () => { stateRefreshes++; };');
  await h.call('submitLogin(testForm)');
  assert.deepEqual(calls, ['/api/doctor/session']);
  assert.equal(h.run('authenticated'), true);
  assert.equal(h.run('doctorCsrf'), 'existing-session-csrf');
  assert.equal(h.run('stateRefreshes'), 1);
  assert.equal(field.value, '');
});

test('a double login submission shares the session bootstrap and sends only one password request', async () => {
  const h = harness('/doktor');
  loginForm(h);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    if (path.endsWith('/session')) {
      await waiting;
      return jsonResponse({ authenticated: false, csrfToken: 'pre-login-csrf' });
    }
    return jsonResponse({ error: { code: 'INVALID_LOGIN', message: 'Giriş doğrulanamadı.' } }, 401);
  };
  const first = h.call('submitLogin(testForm)');
  const second = h.call('submitLogin(testForm)');
  assert.deepEqual(calls, ['/api/doctor/session']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['/api/doctor/session', '/api/doctor/login']);
});

test('an expired doctor data session clears private state and fetches fresh login CSRF without an external redirect', async () => {
  const h = harness('/doktor');
  h.run('authenticated = true; doctorCsrf = "old"; settingsDirty = true; drafts.set("id", { text: "Özel taslak" });');
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    return path.endsWith('/session')
      ? jsonResponse({ authenticated: false, csrfToken: 'fresh-pre-login' })
      : jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Giriş gerekli.' } }, 401);
  };
  await h.call('refreshDoctor()');
  assert.deepEqual(calls, ['/api/doctor/state', '/api/doctor/session']);
  assert.equal(h.run('authenticated'), false);
  assert.equal(h.run('doctorCsrf'), 'fresh-pre-login');
  assert.equal(h.run('doctorState'), null);
  assert.equal(h.run('drafts.size'), 0);
  assert.equal(h.run('settingsDirty'), false);
  assert.match(h.element('app').innerHTML, /id="login-form"/);
  assert.deepEqual(h.redirects, []);
});

test('request fields stay optional and full name follows the phone field', () => {
  const h = harness();
  const markup = h.run('workerMarkup()');
  assert.ok(markup.indexOf('id="request-phone"') < markup.indexOf('id="request-name"'));
  for (const name of ['request-note', 'request-phone', 'request-name']) {
    const tag = markup.match(new RegExp(`<[^>]+id="${name}"[^>]*>`))[0];
    assert.doesNotMatch(tag, /\brequired\b/);
  }
  assert.match(markup, /T\.C\. kimlik numarası, tanı veya özel sağlık bilgisi yazmayın/);
});

test('the employee action appears before supporting information and optional fields start collapsed', () => {
  const h = harness();
  const markup = h.run('workerMarkup()');
  const optional = markup.match(/<details\b[^>]*\bid="worker-options"[^>]*>[\s\S]*?<\/details>/)[0];
  assert.doesNotMatch(optional.slice(0, optional.indexOf('>')), /\bopen\b/);
  assert.match(optional, /Hekime not veya iletişim ekle/);
  assert.match(optional, /İsteğe bağlı|isteğe bağlı/);
  for (const id of ['request-note', 'request-phone', 'request-name']) assert.match(optional, new RegExp(`id="${id}"`));
  assert.match(markup, /Yazı yazmanız gerekmez/);
  assert.ok(markup.indexOf('id="worker-result"') < markup.indexOf('id="worker-form-panel"'));
  assert.ok(markup.indexOf('id="request-form"') < markup.indexOf('id="worker-contacts"'));
  assert.ok(markup.indexOf('id="request-form"') < markup.indexOf('aria-label="Acil durum"'));
});

test('a reply to an older request is prominent while a newer waiting request remains accessible', () => {
  const h = harness();
  renderEmployee(h, [
    employeeRequest('newer', { createdAt: '2026-10-05T09:00:00Z', note: 'Yeni bekleyen talep' }),
    employeeRequest('older', { status: 'answered', note: 'Önceki talep', reply: 'Saat 12.15 civarında revirde olacağım.', repliedAt: '2026-10-05T09:05:00Z' }),
  ]);
  const result = h.element('worker-result').innerHTML;
  assert.match(result, /Hekimden yanıt geldi/);
  assert.match(result, /Saat 12\.15 civarında revirde olacağım\./);
  assert.match(result, /Önceki talep/);
  assert.doesNotMatch(result, /Yeni bekleyen talep|Hekim geldi|geri sayım/);
  assert.match(h.element('worker-other-list').innerHTML, /Yeni bekleyen talep/);
  assert.match(h.element('worker-other-summary').textContent, /1/);
});

test('an incoming reply during polling supersedes a selected waiting request without focus or scroll', () => {
  const h = harness();
  const old = employeeRequest('older', { note: 'Yanıt bekleyen eski talep' });
  const current = employeeRequest('newer', { createdAt: '2026-10-05T09:00:00Z', note: 'Seçilen yeni talep' });
  renderEmployee(h, [current, old]);
  h.run('selectWorkerRequest("newer")');
  h.run('openWorkerForm()');
  h.focusEvents.length = 0;
  h.scrollEvents.length = 0;
  renderEmployee(h, [current, { ...old, status: 'answered', version: 2, reply: 'Lütfen revir önünde bekleyin.', repliedAt: '2026-10-05T09:05:00Z' }]);
  assert.match(h.element('worker-result').innerHTML, /Lütfen revir önünde bekleyin\./);
  assert.equal(h.element('worker-reply-alert').hidden, false);
  assert.deepEqual(h.focusEvents, []);
  assert.deepEqual(h.scrollEvents, []);
});

test('several unread replies and a completed unanswered acknowledgement remain individually accessible', () => {
  const h = harness();
  renderEmployee(h, [
    employeeRequest('first', { status: 'answered', note: 'İlk yanıtlı talep', reply: 'Birinci hekim yanıtı', repliedAt: '2026-10-05T09:00:00Z' }),
    employeeRequest('second', { status: 'done', note: 'Tamamlanmış yanıtlı talep', reply: 'İkinci hekim yanıtı', repliedAt: '2026-10-05T09:05:00Z' }),
    employeeRequest('waiting', { note: 'Yanıt bekliyor' }),
  ]);
  assert.match(h.element('worker-result').innerHTML, /İkinci hekim yanıtı/);
  assert.match(h.element('worker-result').innerHTML, /Tamamlandı/);
  h.run('selectWorkerRequest("first")');
  assert.match(h.element('worker-result').innerHTML, /Birinci hekim yanıtı/);
  h.run('acknowledgeWorkerReply("first")');
  assert.equal(h.run('workerReplySeen(publicState.requests.find(item => item.id === "first"))'), true);
  assert.equal(h.run('workerReplySeen(publicState.requests.find(item => item.id === "second"))'), false);
});

test('reply acknowledgement tracks the actual reply, survives completion, and persists no request content', () => {
  const h = harness();
  const item = employeeRequest('acknowledged', { status: 'answered', note: 'Özel taslak bilgisi', reply: 'Özel hekim yanıtı', repliedAt: '2026-10-05T09:05:00Z' });
  renderEmployee(h, [item]);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), false);
  h.run('acknowledgeWorkerReply("acknowledged")');
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), true);
  const saved = h.storage.get('revir-worker-seen-replies-v1');
  assert.equal(typeof saved, 'string');
  assert.match(saved, /acknowledged/);
  assert.doesNotMatch(saved, /Özel taslak bilgisi|Özel hekim yanıtı/);
  const reloaded = harness();
  reloaded.storage.set('revir-worker-seen-replies-v1', saved);
  renderEmployee(reloaded, [item]);
  assert.equal(reloaded.run('workerReplySeen(publicState.requests[0])'), true);
  renderEmployee(h, [{ ...item, status: 'done', version: 2 }]);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), true);
  renderEmployee(h, [{ ...item, version: 3, reply: 'Güncellenen hekim yanıtı', repliedAt: '2026-10-05T09:10:00Z' }]);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), false);
  assert.match(h.element('worker-result').innerHTML, /Güncellenen hekim yanıtı/);
});

test('request replies remain visible when acceptance stops and cannot inject markup', () => {
  const h = harness();
  renderEmployee(h, [employeeRequest('escaped', {
    status: 'answered', note: '<img src=x onerror=alert(1)>',
    reply: '<script>alert("reply")</script>', repliedAt: '2026-10-05T09:05:00Z',
  })], { availability: { accepting: false, headline: 'Bugün talep alınmıyor' } });
  assert.match(h.element('worker-result').innerHTML, /&lt;script&gt;alert\(&quot;reply&quot;\)&lt;\/script&gt;/);
  assert.match(h.element('worker-result').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h.element('worker-result').innerHTML, /<script|<img/);
  assert.equal(h.element('request-form-submit').disabled, true);
  assertPhysicianContact(h.element('app').innerHTML);
  assert.match(h.element('app').innerHTML, /href="tel:112"/);
});

test('disabled storage does not block loading, acknowledging an answer, or preparing a new request', () => {
  const h = harness();
  h.context.sessionStorage = { getItem() { throw new Error('Storage disabled'); }, setItem() { throw new Error('Storage disabled'); } };
  renderEmployee(h, [employeeRequest('no-storage', { status: 'answered', reply: 'Yanıt storage olmadan görünür.', repliedAt: '2026-10-05T09:05:00Z' })]);
  assert.match(h.element('worker-result').innerHTML, /Yanıt storage olmadan görünür/);
  h.run('acknowledgeWorkerReply("no-storage"); openWorkerForm()');
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), true);
  assert.equal(h.element('worker-form-panel').hidden, false);
  assert.equal(h.element('request-form-submit').disabled, false);
});

test('only an active physician answer offers the two employee presence choices', () => {
  const h = harness();
  renderEmployee(h, [employeeRequest('waiting')]);
  assert.doesNotMatch(h.element('worker-result').innerHTML, /data-action="worker-presence"/);
  renderEmployee(h, [employeeRequest('waiting', { status: 'answered', reply: '10 dakika sonra geleceğim.', repliedAt: '2026-10-05T09:05:00Z' })]);
  const html = h.element('worker-result').innerHTML;
  assert.match(html, /Burada bekliyorum/);
  assert.match(html, /Ayrıldım, sonra geleceğim/);
  assert.equal((html.match(/data-action="worker-presence"/g) || []).length, 2);
  assert.doesNotMatch(html, /data-action="worker-ack"/);
  renderEmployee(h, [employeeRequest('waiting', { status: 'done', reply: '10 dakika sonra geleceğim.', repliedAt: '2026-10-05T09:05:00Z' })]);
  assert.doesNotMatch(h.element('worker-result').innerHTML, /data-action="worker-presence"/);
  assert.match(h.element('worker-result').innerHTML, /data-action="worker-ack"/);
});

test('presence submission saves only after confirmation, coalesces taps and preserves another request draft even after hours', async () => {
  const h = harness();
  const item = employeeRequest('presence-test', { status: 'answered', version: 2, reply: 'Birazdan revirde olacağım.', repliedAt: '2026-10-05T09:05:00Z' });
  renderEmployee(h, [item], { availability: { accepting: false } });
  h.run('workerFormOpen = true; refreshPublic = async () => {}; renderWorker();');
  const form = requestForm(h, { note: 'Ayrı talebin gönderilmemiş notu' });
  h.element('worker-options').open = true;
  h.context.document.activeElement = h.element('request-note');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  h.context.fetch = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body), csrf: options.headers['X-CSRF-Token'] });
    await pending;
    return jsonResponse({ changed: true, request: { ...item, presence: 'left', presenceUpdatedAt: '2026-10-05T09:06:00Z', version: 3 } });
  };
  const first = h.call('submitWorkerPresence("presence-test", "left")');
  const second = h.call('submitWorkerPresence("presence-test", "waiting")');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: '/api/requests/presence-test/presence', body: { presence: 'left', expectedVersion: 2, expectedReplyVersion: 2 }, csrf: 'worker-csrf' });
  assert.equal(h.run('publicState.requests[0].presence'), null);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), false);
  assert.match(h.element('worker-result').innerHTML, /Hekime iletiliyor/);
  release();
  await Promise.all([first, second]);
  assert.equal(h.run('publicState.requests[0].presence'), 'left');
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), true);
  assert.match(h.element('worker-result').innerHTML, /Hekime bildirdiğiniz durum/);
  assert.equal(form.values.note, 'Ayrı talebin gönderilmemiş notu');
  assert.equal(h.element('worker-options').open, true);
  assert.equal(h.context.document.activeElement.id, 'request-note');
  assert.doesNotMatch([...h.storage.values()].join(), /Birazdan revirde|Ayrı talebin/);
});

test('a failed presence save remains unconfirmed and a poll can recover its lost success without another write', async () => {
  const h = harness();
  const item = employeeRequest('lost', { status: 'answered', version: 2, reply: 'Geliyorum.', repliedAt: '2026-10-05T09:05:00Z' });
  renderEmployee(h, [item]);
  h.context.fetch = async () => { throw new Error('Network lost'); };
  await h.call('submitWorkerPresence("lost", "left")');
  assert.equal(h.run('publicState.requests[0].presence'), null);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), false);
  assert.match(h.element('worker-result').innerHTML, /Seçiminiz doğrulanmadı/);
  renderEmployee(h, [{ ...item, presence: 'left', presenceUpdatedAt: '2026-10-05T09:06:00Z', version: 3 }]);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), true);
  assert.doesNotMatch(h.element('worker-result').innerHTML, /Seçiminiz doğrulanmadı/);
  assert.match(h.element('worker-result').innerHTML, /Hekime bildirdiğiniz durum/);
});

test('a stale presence selection loads the newer physician answer and requires a fresh explicit choice', async () => {
  const h = harness();
  const item = employeeRequest('stale', { status: 'answered', version: 2, reply: 'İlk yanıt', repliedAt: '2026-10-05T09:05:00Z' });
  renderEmployee(h, [item]);
  let calls = 0;
  h.context.fetch = async path => {
    calls++;
    if (path.endsWith('/presence')) return jsonResponse({ error: { code: 'VERSION_CONFLICT', message: 'Kayıt değişti' } }, 409);
    return jsonResponse({ ...publicFixture, requests: [{ ...item, version: 3, replyVersion: 3, reply: 'Güncel yanıt' }] });
  };
  await h.call('submitWorkerPresence("stale", "waiting")');
  assert.equal(calls, 2);
  assert.equal(h.run('publicState.requests[0].presence'), null);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), false);
  assert.match(h.element('worker-result').innerHTML, /Güncel yanıt/);
  assert.match(h.element('worker-result').innerHTML, /Burada bekleyecek misiniz/);
});

test('a new physician answer in the same clock tick resets a previously confirmed presence and local seen marker', () => {
  const h = harness();
  const item = employeeRequest('same-time', { status: 'answered', version: 3, presence: 'waiting', presenceUpdatedAt: '2026-10-05T09:06:00Z', reply: 'Birazdan geleceğim.', repliedAt: '2026-10-05T09:05:00Z' });
  renderEmployee(h, [item]);
  h.run('acknowledgeWorkerReply("same-time")');
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), true);
  renderEmployee(h, [{ ...item, replyVersion: 4, version: 4, presence: null, presenceUpdatedAt: null }]);
  assert.equal(h.run('workerReplySeen(publicState.requests[0])'), false);
  assert.match(h.element('worker-result').innerHTML, /Burada bekleyecek misiniz/);
  assert.doesNotMatch(h.element('worker-result').innerHTML, /Hekime bildirdiğiniz durum/);
});

test('physician sees last reported presence, unspecified state and departures regardless of the new-request filter', () => {
  const h = harness('/doktor');
  const reply = { status: 'answered', reply: 'Geliyorum.', repliedAt: '2026-10-05T09:05:00Z' };
  const unknown = employeeRequest('unknown', reply);
  const left = employeeRequest('left', { ...reply, presence: 'left', presenceUpdatedAt: '2026-10-05T09:06:00Z', fullName: '<Örnek>' });
  const waiting = employeeRequest('waiting', { ...reply, presence: 'waiting', presenceUpdatedAt: '2026-10-05T09:07:00Z' });
  h.context.records = [unknown, left, waiting];
  h.run('doctorState = { requests: records }; filter = "new"; renderDoctorPresenceSummary()');
  const summary = h.element('doctor-presence-summary').innerHTML;
  assert.equal(h.element('doctor-presence-summary').hidden, false);
  assert.equal(h.run('filter'), 'new');
  assert.match(summary, /Bekliyor <strong>1/);
  assert.match(summary, /Ayrıldı <strong>1/);
  assert.match(summary, /Belirtmedi <strong>1/);
  assert.match(summary, /&lt;Örnek&gt;/);
  assert.match(summary, /data-action="doctor-presence-request"/);
  h.context.item = unknown;
  assert.match(h.run('requestMarkup(item)'), /Bekleme durumu belirtilmedi/);
  h.context.item = left;
  assert.match(h.run('requestMarkup(item)'), /Ayrıldı, sonra gelecek/);
  assert.match(h.run('requestMarkup(item)'), /Son bildirim:/);
  h.run('drafts.set(item.id, { text: "Gönderilmemiş hekim yanıtı", version: 1, conflict: false }); item.version = 3; requestMarkup(item)');
  assert.equal(h.run('drafts.get(item.id).text'), 'Gönderilmemiş hekim yanıtı');
  assert.equal(h.run('drafts.get(item.id).conflict'), true);
});

test('emergency dial link stays directly accessible while the clinic is closed or a request is active', () => {
  for (const hasActiveRequest of [false, true]) {
    const h = harness();
    const id = '12345678-1234-1234-1234-123456789012';
    h.context.fixture = {
      ...publicFixture,
      availability: { accepting: false, headline: 'Revir kapalı' },
      activeRequestId: hasActiveRequest ? id : null,
      requests: hasActiveRequest ? [{ id, status: 'new', createdAt: '2026-10-05T06:00:00Z', expiresAt: '2026-10-12T06:00:00Z' }] : [],
    };
    h.run('publicState = fixture; renderWorker()');
    const markup = h.element('app').innerHTML;
    const emergency = markup.slice(markup.indexOf('<section class="worker-emergency"'), markup.indexOf('</section>', markup.indexOf('<section class="worker-emergency"')));
    assert.doesNotMatch(emergency.split('>')[0], /\bhidden\b/);
    assert.doesNotMatch(emergency, /<details/);
    const link = markup.match(/<a[^>]+href="tel:112"[^>]*>[\s\S]*?<\/a>/)[0];
    assert.match(link, /112/);
    assert.match(link, /arama ekranını aç/i);
    assert.doesNotMatch(link, /\bdisabled\b|\bonclick\b|\bdata-action\b/);
    assert.match(markup, /ilk yardım için <strong>kurumunuzun tuşlama sırasını<\/strong>/);
    assert.equal(h.element('request-form-submit').disabled, true);
    assert.deepEqual(h.redirects, []);
  }
});

test('a public API failure retains the emergency dial link without initiating a call or another request', async () => {
  const h = harness();
  const paths = [];
  h.context.fetch = async path => { paths.push(path); throw new Error('offline'); };
  await h.call('refreshPublic()');
  assert.deepEqual(paths, ['/api/public']);
  assert.match(h.element('app').innerHTML, /Revir sayfasına ulaşılamadı/);
  assert.match(h.element('app').innerHTML, /href="tel:112"/);
  assert.match(h.element('app').innerHTML, /Doktoru veya yanıtını beklemeyin\./);
  assertPhysicianContact(h.element('app').innerHTML);
  assert.deepEqual(h.redirects, []);
});

function assertPhysicianContact(markup) {
  assert.match(markup, /<h2>İşyeri hekimi<\/h2>/);
  assert.match(markup, /Dr\. Örnek Hekim/);
  assert.match(markup, /0500 000 00 00/);
  assert.match(markup, /href="mailto:hekim@ornek-kurum\.example"/);
  const dial = markup.match(/<a[^>]+href="tel:\+905000000000"[^>]*>[\s\S]*?<\/a>/)[0];
  assert.match(dial, /Hekimi ara/);
  assert.doesNotMatch(dial, /\bonclick\b|\bdata-action\b|\bdisabled\b/);
  assert.equal((markup.match(/aria-label="İşyeri hekimi iletişim bilgileri"/g) || []).length, 1);
  assert.doesNotMatch(markup, /iş telefonu henüz tanımlanmadı/);
}

test('physician contact is available while closed and does not replace the separate emergency number', () => {
  const h = harness();
  h.context.fixture = { ...publicFixture, availability: { accepting: false } };
  h.run('publicState = fixture; renderWorker()');
  assertPhysicianContact(h.element('app').innerHTML);
  assert.match(h.element('app').innerHTML, /href="tel:112"/);
  assert.equal(h.element('request-form-submit').disabled, true);
  assert.deepEqual(h.redirects, []);
});

test('initial employee loading shows contact details before the public API completes without calling either number', async () => {
  const h = harness();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  h.element('app').innerHTML = '<div class="loading">Bilgiler yükleniyor…</div>';
  h.context.setInterval = () => 0;
  const paths = [];
  h.context.fetch = async path => { paths.push(path); await waiting; return jsonResponse(publicFixture); };
  h.run(source.slice(source.lastIndexOf('\nif (isDoctor) {')));
  assertPhysicianContact(h.element('app').innerHTML);
  assert.match(h.element('app').innerHTML, /Bilgiler yükleniyor/);
  assert.match(h.element('app').innerHTML, /href="tel:112"/);
  assert.deepEqual(paths, ['/api/public']);
  assert.deepEqual(h.redirects, []);
  release();
  await h.call('publicReadPromise');
  assertPhysicianContact(h.element('app').innerHTML);
});

test('configured extra work phone is preserved but an identical physician number is not shown twice', () => {
  const h = harness();
  for (const phone of ['0500 000 00 00', '+90 500 000 00 00']) {
    h.context.contacts = { workPhone: phone };
    const markup = h.run('contactsMarkup(contacts)');
    assertPhysicianContact(markup);
    assert.doesNotMatch(markup, /Revir iş telefonu/);
    assert.equal((markup.match(/href="https:\/\/wa.me\/905000000000"/g) || []).length, 1);
  }
  h.context.contacts = { workPhone: '1234', emergencyText: 'İşyerinin acil yardım açıklaması.' };
  const markup = h.run('contactsMarkup(contacts)');
  assertPhysicianContact(markup);
  assert.match(markup, /href="tel:1234"/);
  assert.match(markup, /İş telefonunu ara/);
  assert.doesNotMatch(markup, /İşyerinin acil yardım açıklaması/);
  assert.match(h.run('emergencyMarkup(contacts)'), /İşyerinin acil yardım açıklaması/);
});

test('several unfinished same-day requests stay visible while another request can be submitted', () => {
  const h = harness();
  const requests = Array.from({ length: 6 }, (_, index) => ({
    id: `request-${index}`, status: index % 2 ? 'answered' : 'new',
    note: `Ayrı talep ${index + 1}`, createdAt: '2026-10-05T06:00:00Z', expiresAt: '2026-10-12T06:00:00Z',
  }));
  h.context.fixture = { ...publicFixture, activeRequestId: requests[0].id, requests };
  h.run('publicState = fixture; renderWorker()');
  assert.equal(h.element('request-form-submit').disabled, false);
  assert.equal(h.element('request-form-submit').textContent, 'Geldiğimi doktora bildir');
  const visibleRequests = h.element('worker-result').innerHTML + h.element('worker-other-list').innerHTML;
  for (let index = 0; index < requests.length; index++) assert.match(visibleRequests, new RegExp(`Ayrı talep ${index + 1}`));
  assert.match(h.element('worker-other-summary').textContent, /5/);
  h.run('openWorkerForm()');
  assert.equal(h.element('worker-form-panel').hidden, false);
  assert.doesNotMatch(h.element('app').innerHTML, /Bugünkü talebiniz iletildi|Bugün için devam eden bir talebiniz/);
});

test('successful distinct requests reset the form and use separate operation identities even with an unfinished request', async () => {
  const h = harness();
  h.context.fixture = { ...publicFixture, requests: [] };
  h.run('publicState = fixture; renderWorker(); refreshPublic = async () => {};');
  const form = requestForm(h, { note: 'İlk talep' });
  const bodies = [];
  h.context.fetch = async (path, options) => {
    assert.equal(path, '/api/requests');
    const body = JSON.parse(options.body);
    bodies.push(body);
    return jsonResponse({ created: true, request: { id: body.operationId, status: 'new', note: body.note, createdAt: '2026-10-05T06:00:00Z', expiresAt: '2026-10-12T06:00:00Z' } });
  };
  await h.call('submitRequest(testForm)');
  assert.equal(form.values.note, '');
  assert.equal(form.resetCount, 1);
  assert.equal(h.element('worker-form-panel').hidden, true);
  assert.equal(h.element('worker-result').hidden, false);
  assert.match(h.element('worker-result').innerHTML, /Talebiniz iletildi/);
  assert.match(h.element('worker-result').innerHTML, /İlk talep/);
  assert.equal(h.element('request-form-submit').disabled, true);
  h.advance(800);
  h.run('renderWorker()');
  assert.equal(h.element('request-form-submit').disabled, false);
  h.run('openWorkerForm()');
  assert.equal(h.element('worker-form-panel').hidden, false);
  form.values.note = 'İkinci farklı talep';
  await h.call('submitRequest(testForm)');
  assert.equal(form.resetCount, 2);
  assert.equal(h.run('publicState.requests.length'), 2);
  assert.deepEqual(bodies.map(body => body.note), ['İlk talep', 'İkinci farklı talep']);
  assert.notEqual(bodies[0].operationId, bodies[1].operationId);
  assert.notEqual(h.run('operation.operationId'), bodies[1].operationId);
});

test('an uncertain request retries the same operation and an idempotent success clears it before starting the next request', async () => {
  const h = harness();
  h.context.fixture = { ...publicFixture, requests: [] };
  h.run('publicState = fixture; renderWorker(); refreshPublic = async () => {};');
  const form = requestForm(h, { note: 'Bu talep kaybolmasın' });
  const bodies = [];
  h.context.fetch = async (path, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) throw new Error('Response lost');
    return jsonResponse({ created: false, request: { id: body.operationId, status: 'new', note: body.note, createdAt: '2026-10-05T06:00:00Z', expiresAt: '2026-10-12T06:00:00Z' } });
  };
  const identity = h.run('operation.operationId');
  await h.call('submitRequest(testForm)');
  assert.equal(form.values.note, 'Bu talep kaybolmasın');
  assert.equal(form.resetCount, 0);
  assert.equal(h.run('operation.operationId'), identity);
  await h.call('submitRequest(testForm)');
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(form.values.note, '');
  assert.equal(form.resetCount, 1);
  assert.equal(h.run('publicState.requests.length'), 1);
  assert.notEqual(h.run('operation.operationId'), identity);
});

test('a physical double tap after a fast success creates one request and polling preserves its brief cooldown', async () => {
  const h = harness();
  h.context.fixture = { ...publicFixture, requests: [] };
  h.run('publicState = fixture; renderWorker(); refreshPublic = async () => {};');
  const form = requestForm(h);
  let writes = 0;
  h.context.fetch = async (path, options) => {
    writes++;
    const body = JSON.parse(options.body);
    return jsonResponse({ created: true, request: { id: body.operationId, status: 'new', createdAt: '2026-10-05T06:00:00Z', expiresAt: '2026-10-12T06:00:00Z' } });
  };
  await h.call('submitRequest(testForm)');
  h.advance(150);
  h.run('renderWorker()');
  assert.equal(h.element('request-form-submit').disabled, true);
  await h.call('submitRequest(testForm)');
  assert.equal(writes, 1);
  assert.equal(form.resetCount, 1);
  h.advance(650);
  h.run('renderWorker()');
  assert.equal(h.element('request-form-submit').disabled, false);
  await h.call('submitRequest(testForm)');
  assert.equal(writes, 2);
});

test('a lost blank submission response remains retryable even if polling discovers the accepted request', async () => {
  const h = harness();
  renderEmployee(h);
  const form = requestForm(h);
  const identity = h.run('operation.operationId');
  h.context.fetch = async () => { throw new Error('Response lost'); };
  await h.call('submitRequest(testForm)');
  renderEmployee(h, [employeeRequest('server-created')]);
  assert.equal(h.element('worker-form-panel').hidden, false);
  assert.equal(h.element('worker-form-title').textContent, 'Gönderimi tekrar dene');
  assert.equal(h.run('operation.operationId'), identity);
  assert.equal(form.resetCount, 0);
  assert.match(h.element('request-message').innerHTML, /ulaşılamadı/);
  let posted;
  h.run('refreshPublic = async () => {};');
  h.context.fetch = async (path, options) => {
    posted = JSON.parse(options.body);
    return jsonResponse({ created: false, request: employeeRequest('server-created') });
  };
  await h.call('submitRequest(testForm)');
  assert.equal(posted.operationId, identity);
  assert.equal(h.element('worker-form-panel').hidden, true);
  assert.equal(h.run('workerRetryPending'), false);
  assert.equal(form.resetCount, 1);
});

test('routine employee refreshes are quiet while connection failures remain announced', () => {
  const h = harness();
  h.run('lastSuccess = new Date(); renderConnection()');
  assert.equal(h.element('connection').getAttribute('aria-live'), 'off');
  h.run('connectionError = "Bağlantı kesildi"; renderConnection()');
  assert.equal(h.element('connection').getAttribute('aria-live'), 'polite');
  assert.match(h.element('connection').innerHTML, /Bağlantı kesildi/);
});

test('a double submission sends one request while a response is pending', async () => {
  const h = harness();
  h.context.fixture = { ...publicFixture, requests: [] };
  h.run('publicState = fixture; renderWorker(); refreshPublic = async () => {};');
  const form = requestForm(h, { note: 'Tek bildirim' });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const bodies = [];
  h.context.fetch = async (path, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    await waiting;
    return jsonResponse({ created: true, request: { id: body.operationId, status: 'new', createdAt: '2026-10-05T06:00:00Z', expiresAt: '2026-10-12T06:00:00Z' } });
  };
  const first = h.call('submitRequest(testForm)');
  const second = h.call('submitRequest(testForm)');
  assert.equal(bodies.length, 1);
  assert.equal(form.dataset.busy, 'true');
  release();
  await Promise.all([first, second]);
  assert.equal(form.resetCount, 1);
  assert.equal(form.dataset.busy, 'false');
  assert.equal(h.element('request-form-submit').disabled, true);
});

test('a request retry keeps its operation ID across midnight and reload; a successful response can start another operation', () => {
  const h = harness();
  h.run('loadOperation("2026-10-05")');
  const first = h.run('operation.operationId');
  h.run('loadOperation("2026-10-06")');
  assert.equal(h.run('operation.operationId'), first);
  assert.equal(h.run('operation.formDate'), '2026-10-06');
  // An initial render also reads that unresolved identity from sessionStorage.
  h.run('operation = null; loadOperation("2026-10-08")');
  assert.equal(h.run('operation.operationId'), first);
  h.run('loadOperation("2026-10-08", true)');
  assert.notEqual(h.run('operation.operationId'), first);
});

test('public polling updates status/history without replacing the request form or changing its draft', () => {
  const h = harness();
  h.context.fixture = publicFixture;
  h.run('publicState = fixture; renderWorker()');
  const page = h.element('app').innerHTML;
  h.element('worker-options').open = true;
  h.element('worker-contact-details').open = true;
  h.element('worker-schedule-details').open = true;
  h.context.document.activeElement = h.element('request-note');
  h.focusEvents.length = 0;
  h.scrollEvents.length = 0;
  h.element('request-form').values = { note: 'Yazmaya devam ediyorum', phone: '123', fullName: 'Örnek Kullanıcı' };
  h.run('publicState = { ...fixture, formDate: "2026-10-06", availability: { accepting: false, headline: "Kapalı" } }; renderWorker()');
  assert.equal(h.element('app').innerHTML, page);
  assert.equal(h.element('request-form').values.note, 'Yazmaya devam ediyorum');
  assert.equal(h.element('worker-options').open, true);
  assert.equal(h.element('worker-contact-details').open, true);
  assert.equal(h.element('worker-schedule-details').open, true);
  assert.equal(h.context.document.activeElement.id, 'request-note');
  assert.deepEqual(h.focusEvents, []);
  assert.deepEqual(h.scrollEvents, []);
  assert.equal(h.element('request-form-submit').disabled, true);
  assert.equal(h.run('operation.formDate'), '2026-10-06');
  assert.match(h.element('worker-status').innerHTML, /Kapalı/);
});

test('expired employee session refreshes immediately and keeps unsent form values and operation ID', async () => {
  const h = harness();
  h.context.fixture = publicFixture;
  h.run('publicState = fixture; loadOperation(fixture.formDate); let refreshCount = 0; api = async () => { const error = new Error("Oturum sona erdi"); error.status = 401; throw error; }; refreshPublic = async () => { refreshCount++; }; renderWorker = () => {};');
  const identity = h.run('operation.operationId');
  const form = h.element('request-form');
  form.values = { note: 'Kaybolmasın', phone: '', fullName: '' };
  h.context.testForm = form;
  await h.call('submitRequest(testForm)');
  assert.equal(h.run('refreshCount'), 1);
  assert.equal(h.run('operation.operationId'), identity);
  assert.equal(form.values.note, 'Kaybolmasın');
  assert.equal(form.dataset.busy, 'false');
});

test('doctor polling retains unsaved settings and reply drafts when another record changes', () => {
  const h = harness('/doktor');
  h.run(`doctorMounted = true; settingsDirty = true; settingsVersion = 1; settingsDate = "2026-10-05";
    doctorState = { settings: { version: 2, formDate: "2026-10-05" }, availability: { accepting: true },
      requests: [{ id: "12345678-1234-1234-1234-123456789012", status: "new", version: 2, createdAt: "2026-10-05T06:00:00Z", expiresAt: "2026-10-12T06:00:00Z" }] };
    drafts.set(doctorState.requests[0].id, { text: "Henüz göndermediğim <yanıt>", returnMinutes: null, version: 1, conflict: false, message: "", tone: "error" });
    renderDoctor();`);
  assert.equal(h.run('settingsDirty'), true);
  assert.equal(h.run('settingsConflict'), true);
  assert.match(h.element('settings-message').innerHTML, /Yazdıklarınız korunuyor/);
  assert.match(h.element('doctor-requests').innerHTML, /Henüz göndermediğim &lt;yanıt&gt;/);
  assert.equal(h.run('drafts.get(doctorState.requests[0].id).version'), 1);
});

test('doctor identity is escaped and logout creates a fresh anonymous session without provider navigation', async () => {
  const h = harness('/doktor');
  h.run(`doctorEmail = "doctor<test>@example.com"; authenticated = true; doctorCsrf = "doctor-csrf";
    doctorState = { settings: {}, availability: { accepting: true }, requests: [] };
    populateSettings = () => {}; renderDoctorRequests = () => {}; renderDoctor();`);
  assert.match(h.element('header-actions').innerHTML, /doctor&lt;test&gt;@example.com/);
  const button = new h.context.Element();
  button.dataset.action = 'logout';
  const target = new h.context.Element();
  target.closest = () => button;
  h.run('settingsDirty = true; drafts.set("id", { text: "Taslak" });');
  const calls = [];
  h.context.fetch = async (path, options) => {
    calls.push(path);
    if (path.endsWith('/logout')) {
      assert.equal(options.headers['X-CSRF-Token'], 'doctor-csrf');
      return jsonResponse({ authenticated: false });
    }
    return jsonResponse({ authenticated: false, csrfToken: 'new-anonymous-csrf' });
  };
  await h.listeners.get('click')({ target });
  assert.deepEqual(calls, ['/api/doctor/logout', '/api/doctor/session']);
  assert.deepEqual(h.redirects, []);
  assert.equal(h.run('authenticated'), false);
  assert.equal(h.run('doctorCsrf'), 'new-anonymous-csrf');
  assert.equal(h.run('settingsDirty'), false);
  assert.equal(h.run('drafts.size'), 0);
  assert.equal(h.run('doctorState'), null);
  assert.match(h.element('login-message').innerHTML, /Hekim oturumu kapatıldı/);
});

test('authenticated session bootstrap opens the existing doctor session without asking for a password again', async () => {
  const h = harness('/doktor');
  h.context.fetch = async () => jsonResponse({ authenticated: true, csrfToken: 'active-csrf', email: 'doctor@example.com' });
  h.run('let stateRefreshes = 0; refreshDoctor = async () => { stateRefreshes++; };');
  await h.call('loadDoctorSession()');
  assert.equal(h.run('authenticated'), true);
  assert.equal(h.run('doctorCsrf'), 'active-csrf');
  assert.equal(h.run('stateRefreshes'), 1);
});

function pushHarness({ ios = false, standalone = false, permission = 'default', existing = false } = {}) {
  const h = harness('/doktor');
  const events = [];
  const keyBytes = Buffer.alloc(65, 1);
  keyBytes[0] = 4;
  const publicKey = keyBytes.toString('base64url');
  const subscription = {
    endpoint: 'https://web.push.apple.com/example-only-test-endpoint',
    options: { applicationServerKey: Uint8Array.from(keyBytes).buffer },
    async unsubscribe() { events.push('browser-unsubscribe'); return true; },
  };
  const registration = {
    pushManager: {
      async getSubscription() { events.push('get-subscription'); return existing ? subscription : null; },
      async subscribe(options) {
        events.push('browser-subscribe');
        assert.equal(options.userVisibleOnly, true);
        assert.equal(options.applicationServerKey.length, 65);
        return subscription;
      },
    },
  };
  h.context.navigator.userAgent = ios ? 'iPhone' : 'Example desktop';
  h.context.navigator.standalone = standalone;
  h.context.navigator.serviceWorker = {
    ready: Promise.resolve(registration),
    async register(url, options) {
      events.push('register-worker');
      assert.equal(url, '/sw.js');
      assert.equal(options.scope, '/');
      assert.equal(options.updateViaCache, 'none');
      return registration;
    },
    async getRegistration() { return registration; },
  };
  h.context.window.PushManager = function PushManager() {};
  h.context.window.Notification = {
    permission,
    requestPermission() {
      events.push('permission-prompt');
      this.permission = 'granted';
      return Promise.resolve('granted');
    },
  };
  h.context.window.isSecureContext = true;
  h.context.pushSubscription = subscription;
  h.run('authenticated = true; doctorMounted = true; doctorCsrf = "doctor-csrf";');
  return { ...h, events, subscription, publicKey };
}

test('iPhone Safari gives home screen instructions without registering push or asking permission', async () => {
  const h = pushHarness({ ios: true });
  await h.call('loadPushPanel()');
  assert.deepEqual(h.events, []);
  assert.match(h.element('doctor-push').innerHTML, /Paylaş → Ana Ekrana Ekle/);
  assert.match(h.element('doctor-push').innerHTML, /iOS 16\.4/);
  assert.doesNotMatch(h.element('doctor-push').innerHTML, /data-action="push-enable"/);
});

test('push bootstrap renews an approved existing device with CSRF and browser expiry only once per login without prompting or subscribing', async () => {
  const h = pushHarness({ ios: true, standalone: true, permission: 'granted', existing: true });
  h.subscription.expirationTime = h.run('Date.now() + 3600000');
  const paths = [];
  h.context.fetch = async (path, options) => {
    paths.push(path);
    if (path.endsWith('/subscribe')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-CSRF-Token'], 'doctor-csrf');
      assert.deepEqual(JSON.parse(options.body), { endpoint: h.subscription.endpoint, expirationTime: h.subscription.expirationTime });
      return jsonResponse({ ok: true });
    }
    assert.equal(options.method, 'GET');
    return jsonResponse({ configured: true, publicKey: h.publicKey });
  };
  await Promise.all([h.call('loadPushPanel()'), h.call('loadPushPanel()')]);
  assert.deepEqual(paths, ['/api/doctor/push', '/api/doctor/push/subscribe']);
  assert.deepEqual(h.events, ['register-worker', 'get-subscription']);
  assert.equal(h.run('pushState.subscription.endpoint'), h.subscription.endpoint);
  assert.equal(h.run('pushState.busy'), false);
  assert.match(h.element('doctor-push').innerHTML, /Test bildirimi gönder/);
  assert.doesNotMatch(h.events.join(), /permission-prompt|browser-subscribe/);
  await h.call('loadPushPanel()');
  assert.equal(paths.filter(path => path.endsWith('/subscribe')).length, 1);
  h.run('renderLogin(); authenticated = true; doctorMounted = true; doctorCsrf = "next-login-csrf";');
  h.context.fetch = async (path, options) => {
    paths.push(path);
    if (path.endsWith('/subscribe')) {
      assert.equal(options.headers['X-CSRF-Token'], 'next-login-csrf');
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ configured: true, publicKey: h.publicKey });
  };
  await h.call('loadPushPanel()');
  assert.equal(paths.filter(path => path.endsWith('/subscribe')).length, 2);
});

test('push bootstrap neither asks permission nor creates or renews a device without an approved existing subscription', async () => {
  for (const setup of [{ permission: 'default', existing: true }, { permission: 'denied', existing: true }, { permission: 'granted', existing: false }]) {
    const h = pushHarness(setup);
    const paths = [];
    h.context.fetch = async path => { paths.push(path); return jsonResponse({ configured: true, publicKey: h.publicKey }); };
    await h.call('loadPushPanel()');
    assert.deepEqual(paths, ['/api/doctor/push']);
    assert.doesNotMatch(h.events.join(), /permission-prompt|browser-subscribe|browser-unsubscribe/);
  }
});

test('automatic renewal refuses invalid configuration, a changed application key or an expired browser subscription', async () => {
  for (const invalid of ['configuration', 'mismatch', 'expired']) {
    const h = pushHarness({ permission: 'granted', existing: true });
    if (invalid === 'mismatch') h.subscription.options.applicationServerKey = new Uint8Array(65).buffer;
    if (invalid === 'expired') h.subscription.expirationTime = h.run('Date.now() - 1');
    const paths = [];
    h.context.fetch = async path => {
      paths.push(path);
      return jsonResponse({ configured: true, publicKey: invalid === 'configuration' ? 'invalid-key' : h.publicKey });
    };
    await h.call('loadPushPanel()');
    assert.deepEqual(paths, ['/api/doctor/push']);
    assert.match(h.element('push-message').innerHTML, /kapatıp bildirimleri yeniden açın/);
    assert.equal(h.run('pushState.busy'), false);
    assert.doesNotMatch(h.events.join(), /permission-prompt|browser-subscribe|browser-unsubscribe/);
  }
});

test('browsers without an exposed application key can renew their already approved endpoint without transmitting key material', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  delete h.subscription.options;
  const paths = [];
  h.context.fetch = async (path, options) => {
    paths.push(path);
    if (path.endsWith('/subscribe')) {
      assert.deepEqual(JSON.parse(options.body), { endpoint: h.subscription.endpoint });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ configured: true, publicKey: h.publicKey });
  };
  await h.call('loadPushPanel()');
  assert.deepEqual(paths, ['/api/doctor/push', '/api/doctor/push/subscribe']);
  assert.doesNotMatch(h.events.join(), /permission-prompt|browser-subscribe/);
});

test('a failed automatic renewal warns without dropping the device and can be retried with the existing manual button', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  h.context.fetch = async path => {
    if (path.endsWith('/subscribe')) throw new Error('offline');
    return jsonResponse({ configured: true, publicKey: h.publicKey });
  };
  await h.call('loadPushPanel()');
  assert.match(h.element('push-message').innerHTML, /Bağlantıyı yenile düğmesine/);
  assert.equal(h.run('pushState.subscription.endpoint'), h.subscription.endpoint);
  assert.equal(h.run('pushRenewedEndpoint'), '');
  assert.equal(h.run('pushState.busy'), false);
  assert.doesNotMatch(h.events.join(), /browser-unsubscribe/);
  h.context.fetch = async (path, options) => {
    assert.equal(path, '/api/doctor/push/subscribe');
    assert.equal(options.headers['X-CSRF-Token'], 'doctor-csrf');
    return jsonResponse({ ok: true });
  };
  await h.call('enablePush()');
  assert.match(h.element('push-message').innerHTML, /bildirimler açıldı/);
  assert.equal(h.run('pushRenewedEndpoint'), h.subscription.endpoint);
  assert.doesNotMatch(h.events.join(), /permission-prompt|browser-subscribe/);
});

test('a stale push panel load cannot renew or restore a device after the login generation changes', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  let resolveConfig;
  const waiting = new Promise(resolve => { resolveConfig = resolve; });
  const paths = [];
  h.context.fetch = async path => { paths.push(path); return waiting; };
  const loading = h.call('loadPushPanel()');
  h.run('renderLogin()');
  resolveConfig(jsonResponse({ configured: true, publicKey: h.publicKey }));
  await loading;
  assert.deepEqual(paths, ['/api/doctor/push']);
  assert.equal(h.run('authenticated'), false);
  assert.equal(h.run('pushState.subscription'), null);
  assert.equal(h.run('pushRenewedEndpoint'), '');
});

test('logout waits for an in-flight renewal before removing the device and never restores its stale result', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  let renewalStarted;
  const started = new Promise(resolve => { renewalStarted = resolve; });
  let finishRenewal;
  const waiting = new Promise(resolve => { finishRenewal = resolve; });
  h.context.fetch = async path => {
    h.events.push(path);
    if (path === '/api/doctor/push') return jsonResponse({ configured: true, publicKey: h.publicKey });
    if (path.endsWith('/subscribe')) { renewalStarted(); return waiting; }
    return path.endsWith('/session') ? jsonResponse({ authenticated: false, csrfToken: 'next-anonymous' }) : jsonResponse({ ok: true });
  };
  const loading = h.call('loadPushPanel()');
  await started;
  const button = new h.context.Element();
  button.dataset.action = 'logout';
  const target = new h.context.Element();
  target.closest = () => button;
  const loggingOut = h.listeners.get('click')({ target });
  assert.equal(h.events.includes('/api/doctor/push/unsubscribe'), false);
  finishRenewal(jsonResponse({ ok: true }));
  await Promise.all([loading, loggingOut]);
  const serverEvents = h.events.filter(event => event.startsWith('/api/'));
  assert.deepEqual(serverEvents, ['/api/doctor/push', '/api/doctor/push/subscribe', '/api/doctor/push/unsubscribe', '/api/doctor/logout', '/api/doctor/session']);
  assert.equal(h.run('authenticated'), false);
  assert.equal(h.run('pushState.subscription'), null);
  assert.equal(h.run('pushRenewedEndpoint'), '');
});

test('enable requests permission in the user gesture and posts only the endpoint with doctor CSRF', async () => {
  const h = pushHarness({ ios: true, standalone: true });
  h.context.key = h.publicKey;
  h.run('pushState.loaded = true; pushState.configured = true; pushState.publicKey = key;');
  const paths = [];
  h.context.fetch = async (path, options) => {
    paths.push(path);
    h.events.push('server-subscribe');
    assert.equal(options.headers['X-CSRF-Token'], 'doctor-csrf');
    assert.deepEqual(JSON.parse(options.body), { endpoint: h.subscription.endpoint });
    return jsonResponse({ ok: true });
  };
  const pending = h.call('enablePush()');
  assert.equal(h.events[0], 'permission-prompt');
  await pending;
  assert.deepEqual(paths, ['/api/doctor/push/subscribe']);
  assert.deepEqual(h.events, ['permission-prompt', 'register-worker', 'get-subscription', 'browser-subscribe', 'server-subscribe']);
  assert.equal(h.run('pushState.busy'), false);
  assert.match(h.element('push-message').innerHTML, /bildirimler açıldı/);
});

test('denied or dismissed permission never creates or sends a subscription', async () => {
  for (const permission of ['denied', 'default']) {
    const h = pushHarness();
    h.context.window.Notification.requestPermission = () => Promise.resolve(permission);
    h.context.key = h.publicKey;
    h.run('pushState.loaded = true; pushState.configured = true; pushState.publicKey = key;');
    await h.call('enablePush()');
    assert.deepEqual(h.events, []);
    assert.equal(h.run('pushState.subscription'), null);
    assert.equal(h.run('pushState.busy'), false);
    assert.match(h.element('push-message').innerHTML, permission === 'denied' ? /izni verilmedi/ : /izni seçilmedi/);
  }
});

test('a failed server registration removes its new browser subscription and shows a retryable error', async () => {
  const h = pushHarness({ permission: 'granted' });
  h.context.key = h.publicKey;
  h.run('pushState.loaded = true; pushState.configured = true; pushState.publicKey = key;');
  h.context.fetch = async () => jsonResponse({ error: { code: 'UNAVAILABLE', message: 'Biraz sonra tekrar deneyin.' } }, 503);
  await h.call('enablePush()');
  assert.equal(h.events.at(-1), 'browser-unsubscribe');
  assert.equal(h.run('pushState.subscription'), null);
  assert.match(h.element('push-message').innerHTML, /Biraz sonra tekrar deneyin/);
});

test('a test push renews the endpoint binding and distinguishes provider acceptance from phone display', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  h.run('pushState.loaded = true; pushState.configured = true; pushState.subscription = pushSubscription;');
  const paths = [];
  h.context.fetch = async (path, options) => {
    paths.push(path);
    assert.deepEqual(JSON.parse(options.body), { endpoint: h.subscription.endpoint });
    return jsonResponse({ ok: true, sent: true });
  };
  await h.call('testPush()');
  assert.deepEqual(paths, ['/api/doctor/push/subscribe', '/api/doctor/push/test']);
  assert.match(h.element('push-message').innerHTML, /Telefonunuzda göründüğünü kontrol edin/);
  assert.doesNotMatch(h.element('push-message').innerHTML, /teslim edildi|telefonunuza ulaştı/i);
});

test('logout unregisters push before dropping the browser subscription and server session', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  h.run('pushState.subscription = pushSubscription;');
  const button = new h.context.Element();
  button.dataset.action = 'logout';
  const target = new h.context.Element();
  target.closest = () => button;
  h.context.fetch = async path => {
    h.events.push(path);
    return path.endsWith('/session') ? jsonResponse({ authenticated: false, csrfToken: 'new-anonymous' }) : jsonResponse({ ok: true });
  };
  await h.listeners.get('click')({ target });
  assert.deepEqual(h.events, ['/api/doctor/push/unsubscribe', 'browser-unsubscribe', '/api/doctor/logout', '/api/doctor/session']);
  assert.equal(h.run('authenticated'), false);
  assert.equal(h.run('pushState.subscription'), null);
});

test('logout still invalidates the physician session after a failed push removal', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  h.run('pushState.subscription = pushSubscription;');
  const button = new h.context.Element();
  button.dataset.action = 'logout';
  const target = new h.context.Element();
  target.closest = () => button;
  h.context.fetch = async path => {
    h.events.push(path);
    if (path.endsWith('/unsubscribe')) return jsonResponse({ error: { code: 'FAIL', message: 'Bağlantı hatası.' } }, 503);
    return path.endsWith('/session') ? jsonResponse({ authenticated: false, csrfToken: 'new-anonymous' }) : jsonResponse({ ok: true });
  };
  await h.listeners.get('click')({ target });
  assert.deepEqual(h.events, ['/api/doctor/push/unsubscribe', 'browser-unsubscribe', '/api/doctor/logout', '/api/doctor/session']);
  assert.equal(h.run('authenticated'), false);
});

test('the service worker safely falls back for unreadable payload without caching or private API requests', async () => {
  const serviceWorker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const notifications = [];
  const sw = vm.createContext({
    self: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
    },
  });
  vm.runInContext(serviceWorker, sw);
  let pending;
  listeners.get('push')({
    get data() { throw new Error('Private payload must not be inspected'); },
    waitUntil(promise) { pending = promise; },
  });
  await pending;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Revir Haberleşme');
  assert.equal(notifications[0].options.body, 'Yeni geliş, mesaj, görüş veya bekleme durumu güncellemesi var.');
  assert.deepEqual(JSON.parse(JSON.stringify(notifications[0].options.data)), { url: '/doktor' });
  assert.doesNotMatch(serviceWorker, /\bcaches\b|\bfetch\s*\(|addEventListener\("fetch"|api\/doctor/);
});

test('notification clicks focus an existing physician window or open only the physician route', async () => {
  const serviceWorker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const existingDoctor of [true, false]) {
    const listeners = new Map();
    const events = [];
    const windows = [{ url: 'https://example.test/', focus: async () => events.push('employee-focus') }];
    if (existingDoctor) windows.push({ url: 'https://example.test/doktor', focus: async () => events.push('doctor-focus') });
    const sw = vm.createContext({
      URL,
      self: {
        location: { origin: 'https://example.test' },
        addEventListener: (name, handler) => listeners.set(name, handler),
        clients: { matchAll: async () => windows, openWindow: async url => events.push(url) },
      },
    });
    vm.runInContext(serviceWorker, sw);
    let pending;
    listeners.get('notificationclick')({ notification: { close() { events.push('close'); } }, waitUntil(promise) { pending = promise; } });
    await pending;
    assert.deepEqual(events, existingDoctor ? ['close', 'doctor-focus'] : ['close', '/doktor']);
  }
});

test('install metadata opens the physician route and all declared bitmap icon sizes exist', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.id, '/doktor');
  assert.equal(manifest.start_url, '/doktor');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.name, 'Revir Hekim');
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const bitmap = await readFile(new URL(`../public/icons/${name}`, import.meta.url));
    assert.equal(bitmap.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(bitmap.readUInt32BE(16), size);
    assert.equal(bitmap.readUInt32BE(20), size);
  }
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /apple-mobile-web-app-capable.*yes/);
  assert.match(page, /apple-touch-icon/);
  assert.doesNotMatch(page, /bildirimi henüz eklenmedi/);
});

test('daily anonymous code stays visible on worker result, history and physician cards without requiring a name', () => {
  const h = harness();
  const item = employeeRequest('code', { visitorCode: 'Pzt-19', visitorDay: '2026-10-05' });
  renderEmployee(h, [item]);
  assert.match(h.element('worker-result').innerHTML, /Takip kodunuz: <strong>Pzt-19<\/strong>/);
  assert.equal(h.element('worker-new-request').textContent, 'Yeni bir geliş bildir');
  assert.equal(h.element('worker-new-request-hint').hidden, false);
  h.context.item = item;
  assert.match(h.run('workerListMarkup([item])'), /Pzt-19/);
  assert.match(h.run('requestMarkup(item)'), /doctor-visitor-code">Pzt-19/);
  assert.doesNotMatch(h.run('requestMarkup(item)'), /İsimsiz talep/);
  h.run('openWorkerForm()');
  assert.equal(h.element('worker-form-title').textContent, 'Yeni geliş bildirimi');
  assert.equal(h.element('worker-new-request-hint').hidden, true);
  h.element('request-note').value = 'Gönderilmemiş not';
  const form = h.element('request-form');
  renderEmployee(h, [{ ...item, version: 2 }]);
  assert.equal(h.element('request-form'), form);
  assert.equal(h.element('request-note').value, 'Gönderilmemiş not');
});

test('physician summary surfaces the latest return to waiting with code and time while preserving the selected filter', () => {
  const h = harness('/doktor');
  h.context.records = [
    employeeRequest('left', { status: 'answered', reply: 'Geliyorum.', visitorCode: 'Pzt-1', presence: 'left', presenceUpdatedAt: '2026-10-05T08:00:00Z' }),
    employeeRequest('back', { status: 'answered', reply: 'Geliyorum.', visitorCode: 'Pzt-19', presence: 'waiting', presenceUpdatedAt: '2026-10-05T10:00:00Z' }),
  ];
  h.run('doctorState = { requests: records }; filter = "new"; renderDoctorPresenceSummary()');
  const summary = h.element('doctor-presence-summary').innerHTML;
  assert.ok(summary.indexOf('Pzt-19') < summary.indexOf('Pzt-1</strong>'));
  assert.match(summary, /class="is-waiting"/);
  assert.match(summary, /Bekliyor ·/);
  assert.equal(h.run('filter'), 'new');
});

test('subscription renewal sends only browser public encryption key and auth secret with canonical base64url', () => {
  const h = harness('/doktor');
  const p256dh = new Uint8Array(65); p256dh[0] = 4; p256dh[64] = 255;
  const auth = Uint8Array.from({ length: 16 }, (_, i) => i + 240);
  h.context.sub = { endpoint: 'https://web.push.apple.com/example', getKey: name => (name === 'p256dh' ? p256dh : auth).buffer,
    toJSON: () => ({ private: 'must not read arbitrary fields' }) };
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(pushSubscriptionBody(sub))')), {
    endpoint: h.context.sub.endpoint, keys: { p256dh: Buffer.from(p256dh).toString('base64url'), auth: Buffer.from(auth).toString('base64url') },
  });
});

test('message and feedback stay folded, after the arrival controls, with user-initiated external communication', () => {
  const h = harness();
  const markup = h.run('workerMarkup()');
  assert.ok(markup.indexOf('id="worker-new-request"') < markup.indexOf('id="worker-message-details"'));
  assert.ok(markup.indexOf('id="worker-feedback-details"') > markup.indexOf('id="worker-schedule-details"'));
  for (const id of ['worker-message-details','worker-feedback-details']) assert.doesNotMatch(markup.match(new RegExp(`<details[^>]+id="${id}"[^>]*>`))[0], /\bopen\b/);
  const wa = markup.match(/<a[^>]+href="https:\/\/wa.me\/905000000000"[^>]*>/)[0];
  assert.match(wa, /noopener noreferrer/); assert.doesNotMatch(wa, /\?text|onclick|data-action/);
  assert.match(markup, /Rutin işlemler için önce buradan haber verin/);
  assert.match(markup, /Doktoru veya yanıtını beklemeyin/);
  assert.match(markup, /112’yi ara/);
});

test('message draft stays attached to its request across polling, request switches and closing availability', () => {
  const h = harness();
  const a = employeeRequest('a'); const b = employeeRequest('b');
  renderEmployee(h,[a,b]);
  h.element('worker-message-text').value='İlk talebimin notu';
  h.element('worker-message-phone').value='0555 000 0000';
  h.run('rememberWorkerMessageDraft()');
  h.element('worker-message-details').open = true;
  const form = h.element('worker-message-form');
  renderEmployee(h,[{...a,version:2},b],{availability:{accepting:false}});
  assert.equal(h.element('worker-message-form'),form);
  assert.equal(h.element('worker-message-text').value,'İlk talebimin notu');
  assert.equal(h.element('worker-message-details').open,true);
  h.run('selectWorkerRequest("b")');
  assert.equal(h.element('worker-message-text').value,'');
  h.element('worker-message-text').value='Diğer talebin notu';h.run('rememberWorkerMessageDraft()');
  h.run('selectWorkerRequest("a")');
  assert.equal(h.element('worker-message-text').value,'İlk talebimin notu');
  assert.equal(h.element('worker-message-phone').value,'0555 000 0000');
});

test('uncertain message retries one operation, coalesces taps, retains text and keeps reply/presence on success', async () => {
  const h = harness();
  const item=employeeRequest('note',{status:'answered',reply:'Geliyorum.',presence:'waiting',presenceUpdatedAt:'2026-10-05T09:00:00Z',version:3});
  renderEmployee(h,[item]);h.element('worker-message-text').value='Kısa not';
  const calls=[];let release;const pending=new Promise(resolve=>release=resolve);
  h.context.fetch=async (path,options)=>{calls.push({path,body:JSON.parse(options.body)});await pending;throw new Error('lost response');};
  const first=h.call('submitWorkerMessage()');await h.call('submitWorkerMessage()');
  assert.equal(calls.length,1);release();await first;
  assert.equal(h.element('worker-message-text').value,'Kısa not');
  h.context.fetch=async (path,options)=>{calls.push({path,body:JSON.parse(options.body)});return jsonResponse({created:false,request:{...item,version:4,messageVersion:1,messages:[{id:'m',text:'Kısa not',createdAt:'2026-10-05T09:02:00Z'}]}});};
  await h.call('submitWorkerMessage()');
  assert.deepEqual(calls[1].body,calls[0].body);
  assert.equal(calls[0].path,'/api/requests/note/messages');
  assert.equal(h.run('publicState.requests[0].presence'),'waiting');
  assert.equal(h.run('publicState.requests[0].reply'),'Geliyorum.');
  assert.equal(h.element('worker-message-text').value,'');
  assert.match(h.element('worker-result').innerHTML,/Kısa not/);
});

test('out-of-order presence and message responses cannot roll back the newer saved state', async () => {
  const h=harness();
  const item=employeeRequest('race',{status:'answered',reply:'Geliyorum.',version:2,presence:'left',presenceUpdatedAt:'2026-10-05T08:00:00Z'});
  renderEmployee(h,[item]);h.element('worker-message-text').value='Yeni not';
  let release;const pending=new Promise(resolve=>release=resolve);
  h.context.fetch=async ()=>{await pending;return jsonResponse({created:true,request:{...item,version:3,messageVersion:1,messages:[{id:'m',text:'Yeni not',createdAt:'2026-10-05T10:00:00Z'}]}});};
  const writing=h.call('submitWorkerMessage()');
  const newest={...item,version:4,messageVersion:1,presence:'waiting',presenceUpdatedAt:'2026-10-05T10:01:00Z',messages:[{id:'m',text:'Yeni not',createdAt:'2026-10-05T10:00:00Z'}]};
  renderEmployee(h,[newest]);release();await writing;
  assert.equal(h.run('publicState.requests[0].version'),4);
  assert.equal(h.run('publicState.requests[0].presence'),'waiting');
  h.context.older={...item,version:2};h.run('adoptWorkerRequest(older)');
  assert.equal(h.run('publicState.requests[0].version'),4);
});

test('feedback is separate from requests, coalesces retries and remains mounted while polling', async () => {
  const h=harness();renderEmployee(h,[],{availability:{accepting:false}});
  h.element('worker-feedback-text').value='Bir düğme görünmüyor.';h.element('worker-feedback-category').value='bug';
  h.element('worker-feedback-details').open=true;
  const form=h.element('worker-feedback-form');const calls=[];
  h.context.fetch=async (path,options)=>{calls.push({path,body:JSON.parse(options.body)});throw new Error('offline');};
  await h.call('submitWorkerFeedback()');
  renderEmployee(h,[],{availability:{accepting:false}});
  assert.equal(h.element('worker-feedback-form'),form);assert.equal(h.element('worker-feedback-details').open,true);
  assert.equal(h.element('worker-feedback-text').value,'Bir düğme görünmüyor.');
  h.context.fetch=async (path,options)=>{calls.push({path,body:JSON.parse(options.body)});return jsonResponse({ok:true,created:false});};
  await h.call('submitWorkerFeedback()');
  assert.deepEqual(calls[0].body,calls[1].body);assert.deepEqual(calls.map(c=>c.path),['/api/feedback','/api/feedback']);
  assert.equal(h.run('publicState.requests.length'),0);assert.equal(h.element('worker-feedback-text').value,'');
});

test('physician messages stay visible across filters and unsafe note/feedback text is escaped', async () => {
  const h=harness('/doktor');
  h.context.item=employeeRequest('msg',{status:'answered',visitorCode:'Cuma-2',messageVersion:1,latestMessageAt:'2026-10-16T10:00:00Z',messages:[{id:'m',text:'<img onerror=alert(1)>',fullName:'<Name>',createdAt:'2026-10-16T10:00:00Z'}]});
  h.run('doctorState={requests:[item]};filter="new";renderDoctorMessageSummary()');
  assert.equal(h.element('doctor-message-summary').hidden,false);assert.equal(h.run('filter'),'new');
  assert.match(h.element('doctor-message-summary').innerHTML,/Cuma-2/);
  assert.match(h.run('requestMarkup(item)'),/&lt;img/);assert.doesNotMatch(h.run('requestMarkup(item)'),/<img/);
  h.run('authenticated=true;doctorMounted=true;doctorCsrf="private-csrf"');
  const calls=[];h.context.fetch=async path=>{calls.push(path);return jsonResponse({feedback:[{id:'f',category:'bug',text:'<script>bad</script>',createdAt:'2026-10-16T10:00:00Z'}]});};
  await h.call('loadDoctorFeedback()');assert.deepEqual(calls,['/api/doctor/feedback']);
  assert.match(h.element('doctor-feedback-list').innerHTML,/&lt;script&gt;/);
  assert.doesNotMatch(h.element('doctor-feedback-list').innerHTML,/<script>/);
});

test('new quick replies fill an editable draft and never send without the physician submit action', async () => {
  const h=harness('/doktor');h.context.item=employeeRequest('quick');h.run('doctorState={requests:[item]}');
  const markup=h.run('requestMarkup(item)');
  assert.match(markup,/Geliyorum, lütfen revir önünde bekleyin/);assert.match(markup,/Yemek molasındayım/);
  const target=h.element('quick-choice');target.dataset={action:'quick-text',id:'quick',text:'Yemek molasındayım.'};target.closest=()=>target;
  const calls=[];h.context.fetch=async path=>{calls.push(path);throw new Error('Should not send');};
  await h.listeners.get('click')({target});
  assert.equal(h.run('drafts.get("quick").text'),'Yemek molasındayım.');assert.deepEqual(calls,[]);
});

test('an arrival after completed requests sends in one tap and coalesces double taps, then requires an explicit separate arrival', async () => {
  const h = harness();
  renderEmployee(h, [employeeRequest('earlier', { status: 'done', reply: 'Önceki yanıt', version: 2 })]);
  const form = requestForm(h);
  h.run('refreshPublic = async () => {}');
  const button = h.element('worker-new-request');
  button.dataset.action = 'worker-new-request'; button.closest = () => button;
  const calls = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  h.context.fetch = async (path, options) => {
    const body = JSON.parse(options.body); calls.push({path,body}); await pending;
    return jsonResponse({created:true,request:employeeRequest(body.operationId,{createdAt:'2026-10-05T10:00:00Z'})});
  };
  const first = h.listeners.get('click')({target:button});
  assert.equal(calls.length, 1);
  assert.equal(button.textContent, 'İletiliyor…');
  assert.equal(button.disabled, true);
  assert.equal(h.element('worker-form-panel').hidden, true);
  await h.listeners.get('click')({target:button});
  assert.equal(calls.length, 1);
  release(); await first;
  assert.equal(h.run('workerSelectedRequestId'), calls[0].body.operationId);
  assert.equal(h.element('worker-form-panel').hidden, true);
  assert.equal(form.resetCount, 1);
  assert.notEqual(h.run('operation.operationId'), calls[0].body.operationId);
  h.advance(800); h.run('renderWorker()');
  assert.equal(button.textContent, 'Yeni bir geliş bildir');
  await h.listeners.get('click')({target:button});
  assert.equal(calls.length, 1);
  assert.equal(h.element('worker-form-panel').hidden, false);
  let prevented = false;
  h.listeners.get('submit')({ target: form, preventDefault() { prevented = true; } });
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.operationId, calls[1].body.operationId);
});

test('a failed one-tap arrival exposes the retry form with the same operation and closed pages do not send', async () => {
  const h = harness(); renderEmployee(h, [employeeRequest('existing', { status: 'done' })]);
  const form = requestForm(h); h.run('refreshPublic = async () => {}');
  const button = h.element('worker-new-request'); button.dataset.action='worker-new-request';button.closest=()=>button;
  const calls=[];h.context.fetch=async (path, options)=>{calls.push(JSON.parse(options.body));throw new Error('Bağlantı kesildi');};
  await h.listeners.get('click')({target:button});
  assert.equal(h.element('worker-form-panel').hidden,false);
  assert.equal(h.run('workerRetryPending'),true);
  assert.equal(h.run('operation.operationId'),calls[0].operationId);
  assert.ok(h.focusEvents.includes('worker-form-title'));
  h.context.fetch=async (path, options)=>{const body=JSON.parse(options.body);calls.push(body);return jsonResponse({created:false,request:employeeRequest(body.operationId)});};
  await h.call('submitRequest(testForm)');
  assert.deepEqual(calls[0],calls[1]);assert.equal(form.resetCount,1);
  h.advance(800);renderEmployee(h,[employeeRequest('existing')],{availability:{accepting:false}});
  button.disabled=false;
  await h.listeners.get('click')({target:button});
  assert.equal(calls.length,2);
});

test('an active request makes another arrival a separate secondary action that can be cancelled without creating a request', async () => {
  for (const status of ['new', 'answered']) {
    const h = harness();
    renderEmployee(h, [employeeRequest('active', { status, reply: status === 'answered' ? 'Geliyorum.' : '' })]);
    requestForm(h);
    const calls = [];
    h.context.fetch = async path => { calls.push(path); throw new Error('No request should be sent'); };
    const button = h.element('worker-new-request');
    button.dataset.action = 'worker-new-request'; button.closest = () => button;
    assert.equal(button.textContent, 'Yeni bir geliş bildir');
    assert.equal(button.classList.contains('worker-another-request'), false);
    assert.match(h.element('worker-new-request-hint').textContent, /Mevcut talebiniz açık/);
    await h.listeners.get('click')({ target: button });
    assert.deepEqual(calls, []);
    assert.equal(h.element('worker-form-panel').hidden, false);
    assert.equal(h.element('worker-form-title').textContent, 'Yeni geliş bildirimi');
    assert.equal(h.element('worker-additional-request-hint').hidden, false);
    const cancel = h.element('worker-cancel-request');
    cancel.dataset.action = 'worker-cancel-request'; cancel.closest = () => cancel;
    await h.listeners.get('click')({ target: cancel });
    assert.equal(h.element('worker-form-panel').hidden, true);
    assert.deepEqual(calls, []);
    assert.equal(h.run('publicState.requests.length'), 1);
  }
});

test('actual message submit and presence click handlers update only the same request and never post a new arrival', async () => {
  const h = harness();
  const item = employeeRequest('current', { status: 'answered', reply: 'On dakika sonra geliyorum.', version: 2, visitorCode: 'Pzt-19' });
  renderEmployee(h, [item]); requestForm(h);
  h.run('refreshPublic = async () => {}');
  h.element('worker-message-text').value = 'Telefonumu eklemek istiyorum.';
  const calls = [];
  h.context.fetch = async (path, options) => {
    const body = JSON.parse(options.body); calls.push({ path, body });
    const current = h.run('publicState.requests[0]');
    if (path.endsWith('/messages')) return jsonResponse({ created: true, request: { ...current, version: current.version + 1, messageVersion: 1, messages: [{ id: 'message', text: body.text, createdAt: '2026-10-05T10:00:00Z' }] } });
    if (path.endsWith('/presence')) return jsonResponse({ changed: true, request: { ...current, version: current.version + 1, presence: body.presence, presenceUpdatedAt: '2026-10-05T10:01:00Z' } });
    if (path === '/api/feedback') return jsonResponse({ created: true });
    throw new Error(`Unexpected path: ${path}`);
  };
  let prevented = 0;
  h.listeners.get('submit')({ target: h.element('worker-message-form'), preventDefault() { prevented++; } });
  await new Promise(setImmediate);
  for (const presence of ['waiting', 'left', 'waiting']) {
    const button = h.element(`presence-${presence}`);
    button.dataset = { action: 'worker-presence', id: item.id, presence }; button.closest = () => button;
    await h.listeners.get('click')({ target: button });
  }
  h.element('worker-feedback-text').value = 'Sentetik uygulama görüşü';
  h.listeners.get('submit')({ target: h.element('worker-feedback-form'), preventDefault() { prevented++; } });
  await new Promise(setImmediate);
  assert.equal(prevented, 2);
  assert.deepEqual(calls.map(call => call.path), ['/api/requests/current/messages', '/api/requests/current/presence', '/api/requests/current/presence', '/api/requests/current/presence', '/api/feedback']);
  assert.equal(h.run('publicState.requests.length'), 1);
  assert.equal(h.run('publicState.requests[0].id'), item.id);
  assert.equal(h.run('publicState.requests[0].visitorCode'), 'Pzt-19');
  assert.equal(h.run('publicState.requests[0].presence'), 'waiting');
  assert.equal(h.run('publicState.requests[0].messages.length'), 1);
});

test('employee forms are separate and presence controls cannot submit the arrival form', () => {
  const h = harness();
  const markup = h.run('workerMarkup()');
  let depth = 0;
  for (const match of markup.matchAll(/<\/?form\b[^>]*>/g)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    assert.ok(depth === 0 || depth === 1, 'forms must never be nested');
  }
  assert.equal(depth, 0);
  h.context.item = employeeRequest('answered', { status: 'answered', reply: 'Geliyorum.' });
  const choices = h.run('workerPresenceMarkup(item)').match(/<button\b[^>]+data-action="worker-presence"[^>]*>/g);
  assert.equal(choices.length, 2);
  choices.forEach(button => assert.match(button, /type="button"/));
});

test('the physician screen starts with compact acceptance status and lists requests before notification and schedule settings', () => {
  const h = harness('/doktor');
  const markup = h.run('doctorMarkup()');
  const position = id => {
    const result = markup.indexOf(`id="${id}"`);
    assert.notEqual(result, -1, `${id} must exist`);
    return result;
  };
  assert.ok(position('doctor-status') < position('doctor-message-summary'));
  assert.ok(position('doctor-status') < position('doctor-requests'));
  for (const id of ['doctor-push', 'settings-details', 'doctor-feedback-details']) {
    assert.ok(position('doctor-requests') < position(id), `${id} must follow requests in source and reading order`);
  }
  assert.doesNotMatch(markup, /doctor-sound/);
  assert.equal((markup.match(/id="doctor-status"/g) || []).length, 1);
});

test('employee and shared status cards identify the physician note and escape its text', () => {
  const h = harness();
  h.context.availability = { accepting: false, headline: '<Başlık>', detail: '<Saat bilgisi>', statusMessage: 'İstasyondayım <img onerror="bad"> & bekliyorum' };
  for (const name of ['statusMarkup', 'workerStatusMarkup']) {
    const markup = h.run(`${name}(availability)`);
    assert.match(markup, /<strong>Hekim notu:<\/strong> İstasyondayım &lt;img onerror=&quot;bad&quot;&gt; &amp; bekliyorum/);
    assert.match(markup, /&lt;Başlık&gt;/);
    assert.match(markup, /&lt;Saat bilgisi&gt;/);
    assert.doesNotMatch(markup, /<img|<Başlık>|<Saat bilgisi>/);
    assert.doesNotMatch(h.run(`${name}({ accepting: true })`), /Hekim notu:/);
  }
});

test('the daily acceptance control posts only its versioned pause change and preserves unsaved settings during a double tap', async () => {
  const h = doctorSettingsHarness({ dirty: true });
  h.fields.statusMessage.value = 'Henüz kaydetmediğim hekim notu';
  h.fields.todayMode.value = 'open';
  h.fields.todayStart.value = '11:00';
  h.fields.todayEnd.value = '16:30';
  h.fields.workPhone.value = '555 12 34';
  const calls = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  h.context.fetch = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body), method: options.method, csrf: options.headers['X-CSRF-Token'] });
    await pending;
    return jsonResponse({ settings: { ...h.context.fixture.settings, version: 8, pausedToday: true }, csrfToken: 'rotated-csrf' });
  };
  const first = h.listeners.get('click')({ target: h.button });
  assert.equal(h.run('doctorPauseBusy'), true);
  assert.match(h.element('doctor-status').innerHTML, /data-action="doctor-toggle-pause" disabled>Kaydediliyor…/);
  await h.listeners.get('click')({ target: h.button });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: '/api/doctor/settings', method: 'POST', csrf: 'doctor-csrf', body: { expectedVersion: 7, formDate: '2026-10-17', pauseToday: true } });
  // A full settings save cannot race against the quick control.
  h.context.settingsForm = h.form;
  await h.call('submitSettings(settingsForm)');
  assert.equal(calls.length, 1);
  release(); await first;
  assert.equal(h.run('doctorPauseBusy'), false);
  assert.equal(h.run('doctorState.settings.pausedToday'), true);
  assert.equal(h.run('settingsDirty'), true);
  assert.equal(h.run('settingsVersion'), 8);
  assert.equal(h.run('settingsDate'), '2026-10-17');
  assert.equal(h.run('doctorCsrf'), 'rotated-csrf');
  assert.equal(h.run('refreshes'), 1);
  assert.equal(h.fields.statusMessage.value, 'Henüz kaydetmediğim hekim notu');
  const draftBody = JSON.parse(JSON.stringify(h.run('settingsBody(settingsForm)')));
  assert.equal(draftBody.expectedVersion, 8);
  assert.equal(draftBody.statusMessage, 'Henüz kaydetmediğim hekim notu');
  assert.deepEqual(draftBody.todayOverride, { open: true, start: '11:00', end: '16:30', message: '' });
  assert.equal(draftBody.workPhone, '555 12 34');
  assert.match(h.element('doctor-status').innerHTML, /Bugünkü kapatmayı kaldır/);
});

test('removing the daily pause keeps the saved schedule and does not force the revir open outside its hours', async () => {
  const h = doctorSettingsHarness({ pausedToday: true });
  const calls = [];
  h.context.fetch = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return jsonResponse({ settings: { ...h.context.fixture.settings, version: 8, pausedToday: false } });
  };
  await h.listeners.get('click')({ target: h.button });
  assert.deepEqual(calls, [{ path: '/api/doctor/settings', body: { expectedVersion: 7, formDate: '2026-10-17', pauseToday: false } }]);
  assert.equal(h.run('doctorState.settings.pausedToday'), false);
  assert.equal(h.run('doctorState.availability.accepting'), false);
  assert.equal(h.run('settingsDirty'), false);
  assert.equal(h.run('settingsVersion'), 8);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('doctorState.schedule'))), h.context.fixture.schedule);
  assert.equal(h.run('refreshes'), 1);
});

test('a daily pause does not advance a settings draft that was based on another version or day', async () => {
  for (const overrides of [{ draftVersion: 6 }, { draftDate: '2026-10-16' }]) {
    const h = doctorSettingsHarness({ dirty: true, ...overrides });
    h.fields.statusMessage.value = 'Eski tabana ait, korunacak taslak';
    h.context.fetch = async () => jsonResponse({ settings: { ...h.context.fixture.settings, version: 8, pausedToday: true } });
    await h.listeners.get('click')({ target: h.button });
    assert.equal(h.run('settingsVersion'), overrides.draftVersion ?? 7);
    assert.equal(h.run('settingsDate'), overrides.draftDate ?? '2026-10-17');
    assert.equal(h.run('settingsDirty'), true);
    assert.equal(h.fields.statusMessage.value, 'Eski tabana ait, korunacak taslak');
  }
});

test('a conflicting daily pause refreshes once, retains the draft and waits for another physician action', async () => {
  const h = doctorSettingsHarness({ dirty: true });
  h.fields.statusMessage.value = 'Kaybolmayan taslak';
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    return jsonResponse({ error: { code: 'VERSION_CONFLICT', message: 'Durum başka bir ekranda değişti.' } }, 409);
  };
  await h.listeners.get('click')({ target: h.button });
  assert.deepEqual(calls, ['/api/doctor/settings']);
  assert.equal(h.run('refreshes'), 1);
  assert.equal(h.run('doctorState.settings.pausedToday'), false);
  assert.equal(h.run('settingsDirty'), true);
  assert.equal(h.fields.statusMessage.value, 'Kaybolmayan taslak');
  assert.equal(h.run('settingsVersion'), 7);
  assert.equal(h.run('doctorPauseBusy'), false);
  assert.match(h.element('doctor-pause-message').innerHTML, /Kontrol edip yeniden dokunun/);
});

test('daily acceptance changes are blocked during settings saves and require an active doctor session', async () => {
  for (const state of ['saving', 'logged-out']) {
    const h = doctorSettingsHarness();
    if (state === 'saving') h.form.dataset.busy = 'true';
    else h.run('authenticated = false');
    const calls = [];
    h.context.fetch = async path => { calls.push(path); throw new Error('Should not send'); };
    await h.listeners.get('click')({ target: h.button });
    assert.deepEqual(calls, []);
    assert.equal(h.run('doctorPauseBusy'), false);
  }
});

test('daily acceptance changes return an expired doctor session to login without retrying the mutation', async () => {
  for (const status of [401, 403]) {
    const h = doctorSettingsHarness({ dirty: true });
    const calls = [];
    h.context.fetch = async path => {
      calls.push(path);
      return path.endsWith('/session')
        ? jsonResponse({ authenticated: false, csrfToken: 'fresh-login-csrf' })
        : jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Giriş gerekli.' } }, status);
    };
    await h.listeners.get('click')({ target: h.button });
    assert.deepEqual(calls, ['/api/doctor/settings', '/api/doctor/session']);
    assert.equal(h.run('authenticated'), false);
    assert.equal(h.run('doctorState'), null);
    assert.equal(h.run('doctorCsrf'), 'fresh-login-csrf');
    assert.equal(h.run('doctorPauseBusy'), false);
    assert.match(h.element('app').innerHTML, /id="login-form"/);
  }
});

test('a feedback notification opens and loads the feedback panel once only after authentication and mounting', () => {
  const h = harness('/doktor');
  h.context.location.hash = '#doctor-feedback-details';
  h.run('let feedbackLoads = 0; loadDoctorFeedback = async () => { feedbackLoads++; }; openDoctorFeedbackTarget();');
  assert.equal(h.run('feedbackLoads'), 0);
  assert.equal(h.element('doctor-feedback-details').open, false);
  h.run('authenticated = true; openDoctorFeedbackTarget();');
  assert.equal(h.run('feedbackLoads'), 0);
  h.run('doctorMounted = true; openDoctorFeedbackTarget(); openDoctorFeedbackTarget();');
  assert.equal(h.run('feedbackLoads'), 1);
  assert.equal(h.element('doctor-feedback-details').open, true);
  assert.equal(h.scrollEvents.filter(event => event.id === 'doctor-feedback-details').length, 1);
  h.run('doctorFeedbackHashHandled = false;');
  h.context.location.hash = '#unrelated';
  h.run('openDoctorFeedbackTarget();');
  assert.equal(h.run('feedbackLoads'), 1);
});

test('a saved daily closure never shows the previous green acceptance state when its follow-up refresh fails', async () => {
  const h = doctorSettingsHarness({ dirty: true });
  h.run('refreshDoctor = actualRefreshDoctor; renderDoctorStatus();');
  assert.match(h.element('doctor-status').innerHTML, /Revir talep kabul ediyor/);
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    return path.endsWith('/settings')
      ? jsonResponse({ settings: { ...h.context.fixture.settings, version: 8, pausedToday: true } })
      : jsonResponse({ error: { code: 'TEMPORARY', message: 'Güncel durum şu anda alınamadı.' } }, 503);
  };
  await h.listeners.get('click')({ target: h.button });
  assert.deepEqual(calls, ['/api/doctor/settings', '/api/doctor/state']);
  assert.equal(h.run('doctorState.settings.pausedToday'), true);
  assert.equal(h.run('doctorState.availability.accepting'), false);
  assert.match(h.element('doctor-status').innerHTML, /doctor-status-label is-closed/);
  assert.match(h.element('doctor-status').innerHTML, /Bugün talep alımı kapalı/);
  assert.doesNotMatch(h.element('doctor-status').innerHTML, /Revir talep kabul ediyor/);
  assert.match(h.element('connection').innerHTML, /Güncel durum şu anda alınamadı/);
});

test('daily pause notices disappear when a new day or another device changes the saved pause state', async () => {
  for (const change of ['next-day', 'other-device']) {
    const h = doctorSettingsHarness({ dirty: true });
    h.context.fetch = async () => jsonResponse({ settings: { ...h.context.fixture.settings, version: 8, pausedToday: true } });
    await h.listeners.get('click')({ target: h.button });
    assert.match(h.element('doctor-pause-message').innerHTML, /Bugün talep alımı kapatıldı/);
    if (change === 'next-day') h.run('doctorState.settings.formDate = "2026-10-18";');
    else h.run('doctorState.settings.pausedToday = false; doctorState.settings.version = 9;');
    h.run('renderDoctorStatus();');
    assert.equal(h.run('doctorPauseMessage'), '');
    assert.equal(h.element('doctor-pause-message').innerHTML, '');
  }
});

test('each feedback notification message reopens and reloads the mounted panel without replacing physician drafts', () => {
  const h = harness('/doktor');
  h.context.location.hash = '#doctor-feedback-details';
  h.run('authenticated = true; doctorMounted = true; let feedbackLoads = 0; loadDoctorFeedback = async () => { feedbackLoads++; }; settingsDirty = true; drafts.set("request-a", { text: "Göndermediğim yanıt" });');
  const originalPage = h.element('app').innerHTML;
  h.run('openDoctorFeedbackTarget(); openDoctorFeedbackTarget();');
  assert.equal(h.run('feedbackLoads'), 1);
  const onMessage = h.listeners.get('serviceworker:message');
  assert.equal(typeof onMessage, 'function');
  onMessage({ data: { type: 'unrelated' } });
  assert.equal(h.run('feedbackLoads'), 1);
  for (let notification = 0; notification < 2; notification++) {
    h.element('doctor-feedback-details').open = false;
    onMessage({ data: { type: 'revir-open-feedback' } });
    assert.equal(h.element('doctor-feedback-details').open, true);
    assert.equal(h.run('feedbackLoads'), notification + 2);
  }
  assert.equal(h.run('settingsDirty'), true);
  assert.equal(h.run('drafts.get("request-a").text'), 'Göndermediğim yanıt');
  assert.equal(h.element('app').innerHTML, originalPage);
  assert.deepEqual(h.redirects, []);
  h.run('authenticated = false;');
  onMessage({ data: { type: 'revir-open-feedback' } });
  assert.equal(h.run('feedbackLoads'), 3);
});

test('a late daily pause response cannot restore private state or CSRF after logout or a changed session', async () => {
  for (const change of ['logout', 'new-session']) {
    const h = doctorSettingsHarness({ dirty: true });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const calls = [];
    h.context.fetch = async path => {
      calls.push(path); await pending;
      return jsonResponse({ settings: { ...h.context.fixture.settings, version: 8, pausedToday: true }, csrfToken: 'stale-response-csrf' });
    };
    const saving = h.listeners.get('click')({ target: h.button });
    assert.equal(h.run('doctorPauseBusy'), true);
    if (change === 'logout') h.run('renderLogin("Oturum kapatıldı", "fresh-login-csrf");');
    else h.run('doctorCsrf = "new-session-csrf"; doctorState.settings = { ...doctorState.settings, version: 10, pausedToday: false };');
    release(); await saving;
    assert.deepEqual(calls, ['/api/doctor/settings']);
    assert.equal(h.run('refreshes'), 0);
    assert.equal(h.run('doctorPauseBusy'), false);
    assert.notEqual(h.run('doctorCsrf'), 'stale-response-csrf');
    if (change === 'logout') {
      assert.equal(h.run('authenticated'), false);
      assert.equal(h.run('doctorState'), null);
      assert.equal(h.run('doctorCsrf'), 'fresh-login-csrf');
      assert.match(h.element('app').innerHTML, /id="login-form"/);
    } else {
      assert.equal(h.run('doctorState.settings.version'), 10);
      assert.equal(h.run('doctorState.settings.pausedToday'), false);
      assert.equal(h.run('doctorCsrf'), 'new-session-csrf');
    }
  }
});

test('late settings and request mutation responses cannot affect a logged-out or replacement physician session', async () => {
  for (const mutation of ['settings', 'request']) for (const sessionChange of ['logout', 'replacement']) for (const status of [200, 403]) {
    const h = doctorSettingsHarness({ dirty: true });
    const item = employeeRequest('audit-request');
    h.context.item = item;
    h.context.settingsForm = h.form;
    h.run('doctorState.requests = [item]; draftFor(item).text = "Gönderilecek yanıt";');
    const calls = []; let release;
    const pending = new Promise(resolve => { release = resolve; });
    h.context.fetch = async path => {
      calls.push(path); await pending;
      if (status === 403) return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Eski oturum sona erdi.' } }, 403);
      return jsonResponse(mutation === 'settings'
        ? { settings: { ...h.context.fixture.settings, version: 8 }, csrfToken: 'stale-mutation-csrf' }
        : { request: { ...item, status: 'answered', reply: 'Gönderilecek yanıt', version: 2 }, csrfToken: 'stale-mutation-csrf' });
    };
    const saving = h.call(mutation === 'settings' ? 'submitSettings(settingsForm)' : 'mutateRequest("audit-request", "answer")');
    if (sessionChange === 'logout') h.run('renderLogin("Oturum kapandı", "fresh-login-csrf");');
    else h.run('doctorCsrf = "replacement-csrf"; doctorState.settings = { ...doctorState.settings, version: 12 }; drafts.set("audit-request", { text: "Yeni oturum taslağı", version: 1 });');
    release(); await saving;
    assert.equal(calls.length, 1, `${mutation}/${sessionChange}/${status} must not refresh or retry the old session`);
    assert.equal(h.run('refreshes'), 0);
    assert.equal(h.run('doctorCsrf'), sessionChange === 'logout' ? 'fresh-login-csrf' : 'replacement-csrf');
    if (sessionChange === 'logout') {
      assert.equal(h.run('authenticated'), false);
      assert.equal(h.run('doctorState'), null);
      assert.match(h.element('app').innerHTML, /id="login-form"/);
    } else {
      assert.equal(h.run('authenticated'), true);
      assert.equal(h.run('doctorState.settings.version'), 12);
      assert.equal(h.run('drafts.get("audit-request").text'), 'Yeni oturum taslağı');
    }
  }
});

test('a saved closed schedule cannot retain the previous green acceptance state if its state refresh fails', async () => {
  const h = doctorSettingsHarness();
  h.context.settingsForm = h.form;
  h.fields.todayMode.value = 'closed';
  h.run('refreshDoctor = actualRefreshDoctor; renderDoctorStatus();');
  assert.match(h.element('doctor-status').innerHTML, /Revir talep kabul ediyor/);
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    return path.endsWith('/settings')
      ? jsonResponse({ settings: { ...h.context.fixture.settings, version: 8, todayOverride: { open: false, message: 'Bugün kapalı' } } })
      : jsonResponse({ error: { code: 'TEMPORARY', message: 'Güncel durum alınamadı.' } }, 503);
  };
  await h.call('submitSettings(settingsForm)');
  assert.deepEqual(calls, ['/api/doctor/settings', '/api/doctor/state']);
  assert.equal(h.run('doctorState.settings.todayOverride.open'), false);
  assert.equal(h.run('doctorState.availability.accepting'), false);
  assert.doesNotMatch(h.element('doctor-status').innerHTML, /Revir talep kabul ediyor/);
});

test('a delayed physician answer cannot roll back a newer polled message and presence update', async () => {
  const h = doctorSettingsHarness();
  const item = employeeRequest('audit-answer');
  h.context.item = item;
  h.run('doctorState.requests = [item]; draftFor(item).text = "Geliyorum.";');
  let release; const pending = new Promise(resolve => { release = resolve; });
  h.context.fetch = async () => {
    await pending;
    return jsonResponse({ request: { ...item, status: 'answered', reply: 'Geliyorum.', replyVersion: 2, version: 2 } });
  };
  const answering = h.call('mutateRequest("audit-answer", "answer")');
  h.context.newest = { ...item, status: 'answered', reply: 'Geliyorum.', replyVersion: 2, version: 3,
    presence: 'waiting', presenceUpdatedAt: '2026-10-17T12:00:00Z', messageVersion: 1,
    messages: [{ id: 'm', text: 'Yeni çalışan notu', createdAt: '2026-10-17T12:00:00Z' }] };
  h.run('doctorState.requests = [newest];');
  release(); await answering;
  assert.equal(h.run('doctorState.requests[0].version'), 3);
  assert.equal(h.run('doctorState.requests[0].presence'), 'waiting');
  assert.equal(h.run('doctorState.requests[0].messages[0].text'), 'Yeni çalışan notu');
});

test('logout still revokes the physician session when browser unsubscription throws', async () => {
  const h = pushHarness({ permission: 'granted', existing: true });
  h.run('pushState.subscription = pushSubscription;');
  h.subscription.unsubscribe = async () => { h.events.push('browser-unsubscribe'); throw new Error('Browser cleanup failed'); };
  const button = new h.context.Element(); button.dataset.action = 'logout'; button.closest = () => button;
  h.context.fetch = async path => {
    h.events.push(path);
    return path.endsWith('/session') ? jsonResponse({ authenticated: false, csrfToken: 'new-anonymous' }) : jsonResponse({ ok: true });
  };
  await h.listeners.get('click')({ target: button });
  assert.deepEqual(h.events, ['/api/doctor/push/unsubscribe', 'browser-unsubscribe', '/api/doctor/logout', '/api/doctor/session']);
  assert.equal(h.run('authenticated'), false);
  assert.equal(h.run('doctorState'), null);
});

test('a delayed employee creation response cannot erase a physician answer already discovered by polling', async () => {
  const h = harness(); renderEmployee(h);
  requestForm(h);
  h.run('refreshPublic = async () => {};');
  let release; const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  h.context.fetch = async (path, options) => {
    const body = JSON.parse(options.body); calls.push({ path, body });
    await pending;
    return jsonResponse({ created: true, request: employeeRequest(body.operationId) });
  };
  const creating = h.call('submitRequest(testForm)');
  assert.equal(calls.length, 1);
  const newer = employeeRequest(calls[0].body.operationId, { status: 'answered', version: 2,
    reply: 'Hemen geliyorum.', replyVersion: 2, repliedAt: '2026-10-05T10:00:00Z' });
  renderEmployee(h, [newer]);
  release(); await creating;
  assert.equal(h.run('publicState.requests[0].version'), 2);
  assert.equal(h.run('publicState.requests[0].reply'), 'Hemen geliyorum.');
  assert.match(h.element('worker-result').innerHTML, /Hemen geliyorum\./);
  assert.equal(h.element('worker-announcement').textContent, 'Talebinizin hekim yanıtı yukarıda.');
});

test('delayed settings and pause acknowledgements cannot replace a newer version or next-day settings snapshot', async () => {
  for (const mutation of ['settings', 'pause']) for (const newer of ['version', 'day']) {
    const h = doctorSettingsHarness({ dirty: true });
    h.fields.statusMessage.value = 'Kaydedilmemiş taslağım';
    h.context.settingsForm = h.form;
    const responseSettings = { ...h.context.fixture.settings, version: 8, pausedToday: true };
    let release; const pending = new Promise(resolve => { release = resolve; });
    h.context.fetch = async () => { await pending; return jsonResponse({ settings: responseSettings }); };
    const saving = h.call(mutation === 'settings' ? 'submitSettings(settingsForm)' : 'toggleDoctorPause()');
    h.context.newerSettings = { ...responseSettings, version: newer === 'version' ? 9 : 8,
      formDate: newer === 'day' ? '2026-10-18' : '2026-10-17', pausedToday: false, statusMessage: 'Daha yeni kayıt' };
    h.run('doctorState.settings = newerSettings; doctorState.availability = { accepting: true, detail: "Güncel açık durum" }; renderDoctor();');
    release(); await saving;
    assert.equal(h.run('doctorState.settings.version'), newer === 'version' ? 9 : 8);
    assert.equal(h.run('doctorState.settings.formDate'), newer === 'day' ? '2026-10-18' : '2026-10-17');
    assert.equal(h.run('doctorState.settings.pausedToday'), false);
    assert.equal(h.run('doctorState.settings.statusMessage'), 'Daha yeni kayıt');
    assert.equal(h.run('doctorState.availability.accepting'), true);
    assert.equal(h.run('settingsVersion'), 7);
    assert.equal(h.run('settingsDate'), '2026-10-17');
    assert.equal(h.run('settingsDirty'), true);
    assert.equal(h.run('settingsConflict'), true);
    assert.equal(h.fields.statusMessage.value, 'Kaydedilmemiş taslağım');
    assert.equal(h.run('refreshes'), 1);
    assert.doesNotMatch(h.element('doctor-pause-message').innerHTML, /Bugün talep alımı kapatıldı/);
  }
});
