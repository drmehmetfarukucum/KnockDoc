import { AppError } from './rules.mjs';

const PREAUTH_MS = 30 * 60_000;
const AUTH_MS = 8 * 60 * 60_000;
const LIMIT_MS = 5 * 60_000;
const encoder = new TextEncoder();
const loginRequired = () => new AppError(401, 'LOGIN_REQUIRED', 'Hekim şifrenizle giriş yapın.');
const loginFailed = () => new AppError(401, 'LOGIN_FAILED', 'Giriş doğrulanamadı. Şifrenizi kontrol edip yeniden deneyin.');

export async function hashKey(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function passwordPepper(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AppError(503, 'DOCTOR_NOT_CONFIGURED', 'Hekim girişi kurulumu henüz tamamlanmadı.');
  }
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), character => character.charCodeAt(0));
  // Require the canonical encoding, including the unused low bits of the final character.
  const canonical = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  if (bytes.length !== 32 || canonical !== value) {
    throw new AppError(503, 'DOCTOR_NOT_CONFIGURED', 'Hekim girişi kurulumu henüz tamamlanmadı.');
  }
  return bytes;
}

/** Short PINs require an independent random server secret; a database/hash leak alone cannot enumerate them. */
export async function hashPassword(value, pepper) {
  const key = await crypto.subtle.importKey('raw', passwordPepper(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`revir-doctor-password-v1\0${value}`)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function configuration(env) {
  const version = typeof env.DOCTOR_KEY_HASH === 'string' ? env.DOCTOR_KEY_HASH : '';
  if (!/^[a-f0-9]{64}$/.test(version)) {
    throw new AppError(503, 'DOCTOR_NOT_CONFIGURED', 'Hekim girişi kurulumu henüz tamamlanmadı.');
  }
  const pepper = env.DOCTOR_KEY_PEPPER;
  if (pepper !== undefined) passwordPepper(pepper);
  const email = typeof env.DOCTOR_EMAIL === 'string' ? env.DOCTOR_EMAIL.trim() : '';
  return { version, email, pepper };
}

function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function cookieName(request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-revir_doctor' : 'revir_doctor_local';
}

function readToken(request) {
  const name = cookieName(request);
  const matches = (request.headers.get('cookie') || '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function cookie(request, token, expires, now) {
  const secure = new URL(request.url).protocol === 'https:';
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.ceil((expires - now) / 1000))}${secure ? '; Secure' : ''}`;
}

function equals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index++) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

/** Password verification stays on the server; browser cookies hold only random tokens. */
export class DoctorAuth {
  constructor(db, clock = () => Date.now()) { this.db = db; this.clock = clock; }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }

  async session(request, env) {
    const config = configuration(env);
    const token = readToken(request);
    if (!token) return null;
    const row = await this.statement(
      'SELECT hash,csrf,expires,authenticated FROM doctor_sessions WHERE hash=? AND credential_version=? AND expires>?',
      await hashKey(token), config.version, this.clock(),
    ).first();
    return row ? { ...row, authenticated: row.authenticated === 1, email: config.email } : null;
  }

  async preauth(request, env) {
    const config = configuration(env);
    const existing = await this.session(request, env);
    if (existing) return { session: existing, cookie: cookie(request, readToken(request), existing.expires, this.clock()) };
    const now = this.clock();
    const token = randomToken();
    const session = { hash: await hashKey(token), csrf: randomToken(), expires: now + PREAUTH_MS, authenticated: false, email: config.email };
    await this.statement('INSERT INTO doctor_sessions(hash,csrf,expires,authenticated,credential_version) VALUES(?,?,?,0,?)',
      session.hash, session.csrf, session.expires, config.version).run();
    return { session, cookie: cookie(request, token, session.expires, now) };
  }

  async require(request, env) {
    const session = await this.session(request, env);
    if (!session?.authenticated) throw loginRequired();
    return session;
  }

  async countAttempt(request, now) {
    // Cloudflare supplies this header at its edge. Only its digest is stored.
    const address = request.headers.get('cf-connecting-ip') || 'local-or-unavailable';
    const ipKey = `ip:${await hashKey(`revir-login-ip-v1\0${address}`)}`;
    const scopes = ['global', ipKey];
    const upsert = `INSERT INTO doctor_login_limits(scope,expires,attempts) VALUES(?,?,1)
      ON CONFLICT(scope) DO UPDATE SET
      attempts=CASE WHEN doctor_login_limits.expires<=? THEN 1 ELSE doctor_login_limits.attempts+1 END,
      expires=CASE WHEN doctor_login_limits.expires<=? THEN excluded.expires ELSE doctor_login_limits.expires END`;
    const result = await this.db.batch([
      ...scopes.map(scope => this.statement(upsert, scope, now + LIMIT_MS, now, now)),
      this.statement('SELECT scope,attempts FROM doctor_login_limits WHERE scope IN (?,?)', ...scopes),
    ]);
    const rows = result[2].results;
    if (rows.some(row => row.attempts > (row.scope === 'global' ? 30 : 10))) {
      throw new AppError(429, 'LOGIN_RATE_LIMITED', 'Çok fazla giriş denemesi yapıldı. Beş dakika sonra yeniden deneyin.');
    }
  }

  async login(request, env, body, suppliedSession) {
    const config = configuration(env);
    requireSameOrigin(request);
    const current = await this.session(request, env);
    if (!current || current.authenticated || !suppliedSession || suppliedSession.hash !== current.hash) throw loginFailed();
    verifyCsrf(request, current.csrf);
    const now = this.clock();
    await this.countAttempt(request, now);
    const password = body?.password;
    const validFormat = typeof password === 'string' && (config.pepper === undefined
      ? /^[A-Za-z0-9_-]{32,128}$/.test(password)
      : /^(?:[0-9]{6}|[A-Za-z0-9_-]{32,128})$/.test(password));
    if (!validFormat) throw loginFailed();
    const passwordHash = config.pepper === undefined ? await hashKey(password) : await hashPassword(password, config.pepper);
    if (!equals(passwordHash, config.version)) throw loginFailed();

    const token = randomToken();
    const next = { hash: await hashKey(token), csrf: randomToken(), expires: now + AUTH_MS, authenticated: true, email: config.email };
    // Consume the pre-login session and create its replacement within one D1
    // transaction. Concurrent retries can authenticate only once.
    const results = await this.db.batch([
      this.statement(`INSERT INTO doctor_sessions(hash,csrf,expires,authenticated,credential_version)
        SELECT ?,?,?,1,? FROM doctor_sessions WHERE hash=? AND csrf=? AND authenticated=0 AND expires>? AND credential_version=?`,
      next.hash, next.csrf, next.expires, config.version, current.hash, current.csrf, now, config.version),
      this.statement('DELETE FROM doctor_sessions WHERE hash=? AND EXISTS(SELECT 1 FROM doctor_sessions WHERE hash=?)', current.hash, next.hash),
      this.statement('SELECT hash FROM doctor_sessions WHERE hash=?', next.hash),
    ]);
    if (!results[2].results.length) throw loginFailed();
    return { session: next, cookie: cookie(request, token, next.expires, now) };
  }

  async logout(request, env, suppliedSession) {
    const config = configuration(env);
    requireSameOrigin(request);
    const current = await this.require(request, env);
    if (!suppliedSession || suppliedSession.hash !== current.hash) throw loginRequired();
    verifyCsrf(request, current.csrf);
    await this.statement('DELETE FROM doctor_sessions WHERE hash=? AND credential_version=?', current.hash, config.version).run();
    return { cookie: cookie(request, '', 0, this.clock()) };
  }

  async cleanup() {
    const now = this.clock();
    await this.db.batch([
      this.statement('DELETE FROM doctor_sessions WHERE expires<=?', now),
      this.statement('DELETE FROM doctor_login_limits WHERE expires<=?', now),
    ]);
  }
}

export function requireSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin
      || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AppError(403, 'ORIGIN_FORBIDDEN', 'İşlem bu uygulama üzerinden yapılmalıdır.');
  }
}

export function verifyCsrf(request, expected) {
  const submitted = request.headers.get('x-csrf-token') || '';
  if (typeof expected !== 'string' || expected.length < 32 || !equals(submitted, expected)) {
    throw new AppError(403, 'CSRF_INVALID', 'Oturum yenilendi. Sayfayı yenileyip yeniden deneyin.');
  }
}
