import { Store } from './store.mjs';
import { AppError } from './rules.mjs';
import { DoctorAuth, requireSameOrigin, verifyCsrf } from './auth.mjs';
import { PushStore, pushConfiguration } from './push.mjs';

const MAX_BODY = 16 * 1024;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function respond(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}

function cookieName(request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-revir_worker' : 'revir_worker_local';
}

function cookieToken(request) {
  const wanted = cookieName(request);
  const cookies = (request.headers.get('Cookie') || '').split(';');
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split('=');
    if (name === wanted) {
      const token = value.join('=');
      return /^[A-Za-z0-9_-]{32,100}$/.test(token) ? token : '';
    }
  }
  return '';
}

function sessionCookie(request, token, expires, now = Date.now()) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request)}=${token}; Path=/; Max-Age=${Math.max(0, Math.ceil((expires - now) / 1000))}; HttpOnly; SameSite=Lax${secure}`;
}

async function limited(binding, key) {
  if (!binding || typeof binding.limit !== 'function') {
    throw new AppError(503, 'RATE_LIMIT_NOT_CONFIGURED', 'Uygulama kurulumu henüz tamamlanmadı.');
  }
  const { success } = await binding.limit({ key });
  if (!success) throw new AppError(429, 'RATE_LIMIT', 'Çok sık denendi. Biraz bekleyip yeniden deneyin.');
}

async function bodyJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new AppError(415, 'INVALID_BODY', 'Gönderim biçimi geçersiz.');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    throw new AppError(413, 'BODY_TOO_LARGE', 'Gönderim çok uzun.');
  }
  let bytes = 0;
  const chunks = [];
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'INVALID_BODY', 'Gönderim okunamadı.');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw new AppError(413, 'BODY_TOO_LARGE', 'Gönderim çok uzun.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged)); }
  catch { throw new AppError(400, 'INVALID_BODY', 'Gönderim okunamadı.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AppError(400, 'INVALID_BODY', 'Gönderim biçimi geçersiz.');
  }
  return result;
}

function protectResponse(response, head = false) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  return new Response(head ? null : response.body, { status: response.status, headers });
}

/** Dependencies are injected by automated tests; request data cannot override them. */
export function createWorker({ makeAuth = env => new DoctorAuth(env.DB), makeStore = env => new Store(env.DB), makePush = env => new PushStore(env.DB) } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      try {
        const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !local) throw new AppError(403, 'HTTPS_REQUIRED', 'Güvenli bağlantı gerekiyor.');
        if (url.search || url.pathname.length > 2048) throw new AppError(400, 'INVALID_PATH', 'Adres geçersiz.');
        const get = request.method === 'GET';
        const head = request.method === 'HEAD';
        if (!get && !head && request.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Bu işlem desteklenmiyor.');
        if (request.method === 'POST') requireSameOrigin(request);

        if (get || head) {
          if (['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'].includes(path)) {
            const assetUrl = new URL(path === '/' ? '/index.html' : path, url);
            return protectResponse(await env.ASSETS.fetch(new Request(assetUrl, { method: head ? 'HEAD' : 'GET' })), head);
          }
          if (path === '/doktor' || path === '/doktor/') {
            // This shell contains only the login form; every private API checks
            // its own server session before reading or changing clinic data.
            return protectResponse(await env.ASSETS.fetch(new Request(new URL('/index.html', url))), head);
          }
        }
        // Everything outside the small static whitelist and explicit API routes stays private.
        const publicApi = path === '/api/public' && get;
        const requestApi = path === '/api/requests' && request.method === 'POST';
        const presenceMatch = request.method === 'POST' && /^\/api\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/presence$/.exec(path);
        const messageMatch = request.method === 'POST' && /^\/api\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/messages$/.exec(path);
        const feedbackApi = path === '/api/feedback' && request.method === 'POST';
        const doctorApi = path.startsWith('/api/doctor/');
        if (!publicApi && !requestApi && !presenceMatch && !messageMatch && !feedbackApi && !doctorApi) throw new AppError(404, 'NOT_FOUND', 'Sayfa bulunamadı.');

        if (doctorApi) {
          if (head) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Bu işlem desteklenmiyor.');
          if (!env.DB) throw new AppError(503, 'DB_NOT_CONFIGURED', 'Kayıt sistemi kurulumu henüz tamamlanmadı.');
          const auth = makeAuth(env);
          if (get && path === '/api/doctor/session') {
            let session = await auth.session(request, env);
            const headers = {};
            if (!session) {
              await limited(env.SESSION_LIMIT, `revir:doctor-session:${request.headers.get('cf-connecting-ip') || 'local'}`);
              const created = await auth.preauth(request, env);
              session = created.session;
              headers['Set-Cookie'] = created.cookie;
            }
            return respond({ authenticated: session.authenticated, csrfToken: session.csrf,
              ...(session.authenticated ? { email: session.email } : {}) }, 200, headers);
          }
          if (request.method === 'POST' && path === '/api/doctor/login') {
            const session = await auth.session(request, env);
            if (!session) throw new AppError(401, 'SESSION_EXPIRED', 'Giriş oturumu sona erdi. Yeniden deneyin.');
            verifyCsrf(request, session.csrf);
            await limited(env.LOGIN_LIMIT, `revir:login:${request.headers.get('cf-connecting-ip') || 'local'}`);
            await limited(env.LOGIN_GLOBAL_LIMIT, 'revir:login:all');
            const loggedIn = await auth.login(request, env, await bodyJson(request), session);
            return respond({ authenticated: true, csrfToken: loggedIn.session.csrf, email: loggedIn.session.email },
              200, { 'Set-Cookie': loggedIn.cookie });
          }
          const session = await auth.require(request, env);
          const csrf = session.csrf;
          if (request.method === 'POST') verifyCsrf(request, csrf);
          if (request.method === 'POST' && path === '/api/doctor/logout') {
            await bodyJson(request);
            const loggedOut = await auth.logout(request, env, session);
            // Authentication revocation must survive a failed best-effort
            // phone subscription cleanup, especially on a shared device.
            try { await makePush(env).removeSession(session.hash, env); } catch { /* The login session is already revoked. */ }
            return respond({ authenticated: false }, 200, { 'Set-Cookie': loggedOut.cookie });
          }
          if (get && path === '/api/doctor/push') {
            const config = pushConfiguration(env);
            return respond({ configured: config.enabled, publicKey: config.enabled ? config.applicationServerKey : '' });
          }
          if (request.method === 'POST' && path.startsWith('/api/doctor/push/')) {
            await limited(env.PUSH_LIMIT, `revir:push:${session.hash}`);
            const body = await bodyJson(request);
            const push = makePush(env);
            if (path === '/api/doctor/push/subscribe') {
              await push.subscribe(body, env, session.hash);
              return respond({ ok: true });
            }
            if (path === '/api/doctor/push/unsubscribe') {
              await push.unsubscribe(body.endpoint, env, session.hash);
              return respond({ ok: true });
            }
            if (path === '/api/doctor/push/test') {
              const result = await push.test(body.endpoint, env, session.hash);
              if (!result.accepted) throw new AppError(503, 'PUSH_NOT_ACCEPTED', 'Bildirim gönderilemedi. Bildirimleri yeniden etkinleştirip deneyin.');
              return respond({ ok: true, sent: true });
            }
            throw new AppError(404, 'NOT_FOUND', 'İşlem bulunamadı.');
          }
          const store = makeStore(env);
          if (get && path === '/api/doctor/state') return respond({ ...await store.doctorState(), csrfToken: csrf });
          if (get && path === '/api/doctor/feedback') return respond(await store.feedback());
          if (request.method === 'POST') {
            const body = await bodyJson(request);
            if (path === '/api/doctor/settings') return respond(await store.updateSettings(body));
            const match = /^\/api\/doctor\/requests\/([0-9a-f-]{36})\/(answer|complete|reopen)$/.exec(path);
            if (match) return respond(await store[match[2]](match[1], body));
          }
          throw new AppError(404, 'NOT_FOUND', 'İşlem bulunamadı.');
        }

        if (!env.DB) throw new AppError(503, 'DB_NOT_CONFIGURED', 'Kayıt sistemi kurulumu henüz tamamlanmadı.');
        const store = makeStore(env);
        // IP only keys short-lived provider rate counters; it never identifies an employee.
        const ip = request.headers.get('cf-connecting-ip') || 'local';
        if (publicApi) {
          await limited(env.PUBLIC_LIMIT, `revir:read:${ip}`);
          let token = cookieToken(request);
          let session = token ? await store.session(token) : null;
          if (!session) {
            await limited(env.SESSION_LIMIT, `revir:session:${ip}`);
            const created = await store.createSession();
            token = created.token;
            session = await store.session(token);
          }
          return respond(await store.publicState(session), 200, { 'Set-Cookie': sessionCookie(request, token, session.expires) });
        }
        const token = cookieToken(request);
        const session = token ? await store.session(token) : null;
        if (!session) throw new AppError(401, 'SESSION_EXPIRED', 'Sayfayı yenileyip yeniden deneyin.');
        verifyCsrf(request, session.csrf);
        await limited(env.SUBMIT_LIMIT, `revir:submit:owner:${session.hash}`);
        await limited(env.SUBMIT_LIMIT, `revir:submit:ip:${ip}`);
        if (feedbackApi) {
          const result = await store.addFeedback(session, await bodyJson(request));
          if (result.created) {
            // Feedback stays separate from clinical requests. Its text and
            // category never leave the app in a phone notification.
            const notification = Promise.resolve().then(() => makePush(env).sendAll(env, { event: { type: 'feedback' } })).catch(() => {});
            if (ctx?.waitUntil) ctx.waitUntil(notification);
            else await notification;
          }
          return respond(result);
        }
        if (messageMatch) {
          const result = await store.addRequestMessage(session, messageMatch[1], await bodyJson(request));
          if (result.created) {
            const event = { type: 'message', code: result.request.visitorCode, day: result.request.visitorDay };
            const notification = Promise.resolve().then(() => makePush(env).sendAll(env, { event })).catch(() => {});
            if (ctx?.waitUntil) ctx.waitUntil(notification);
            else await notification;
          }
          return respond(result, result.created ? 201 : 200);
        }
        if (presenceMatch) {
          const result = await store.updatePresence(session, presenceMatch[1], await bodyJson(request));
          if (result.changed) {
            // Only an anonymous daily code and the saved choice enter the push;
            // personal contact, notes and physician replies stay in the app.
            const event = { type: result.request.presence, code: result.request.visitorCode, day: result.request.visitorDay };
            const notification = Promise.resolve().then(() => makePush(env).sendAll(env, { event })).catch(() => {});
            if (ctx?.waitUntil) ctx.waitUntil(notification);
            else await notification;
          }
          return respond(result);
        }
        const result = await store.createRequest(session, await bodyJson(request));
        const headers = {};
        if (result.created) {
          const fresh = await store.session(token);
          headers['Set-Cookie'] = sessionCookie(request, token, fresh.expires);
          // Delivery is best effort; a provider error must never lose an employee request.
          const event = { type: 'new', code: result.request.visitorCode, day: result.request.visitorDay };
          const notification = Promise.resolve().then(() => makePush(env).sendAll(env, { event })).catch(() => {});
          if (ctx?.waitUntil) ctx.waitUntil(notification);
          else await notification;
        }
        return respond(result, result.created ? 201 : 200, headers);
      } catch (error) {
        const known = error instanceof AppError;
        const status = known ? error.status : 500;
        return respond({ error: { code: known ? error.code : 'SERVER_ERROR', message: known ? error.message : 'İşlem tamamlanamadı. Yazdıklarınızı koruyup yeniden deneyin.' } }, status);
      }
    },
    async scheduled(event, env) {
      await makeStore(env).cleanup();
      await makeAuth(env).cleanup();
      await makePush(env).cleanup(env);
    },
  };
}

export default createWorker();
