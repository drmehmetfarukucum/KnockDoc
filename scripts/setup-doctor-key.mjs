import { randomBytes, createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, stat, lstat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { preparePushSecrets, defaultPushCredentials } from './setup-push-key.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const defaultCredentials = fileURLToPath(new URL('../../../work/revir-cloudflare-giris.txt', import.meta.url));
export const defaultPepperCredentials = fileURLToPath(new URL('../../../work/revir-doctor-pepper.json', import.meta.url));

const validKey = key => typeof key === 'string' && /^(?:[0-9]{6}|[A-Za-z0-9_-]{43})$/.test(key);
const validPepper = pepper => typeof pepper === 'string' && /^[A-Za-z0-9_-]{43}$/.test(pepper)
  && Buffer.from(pepper, 'base64url').length === 32 && Buffer.from(pepper, 'base64url').toString('base64url') === pepper;

export async function loadKey(credentials, create = false) {
  let text;
  try { text = await readFile(credentials, 'utf8'); }
  catch (error) {
    // Never point to a key-creating command here: on a live deployment a new
    // key would replace the physician password check and phone subscriptions.
    if (error.code !== 'ENOENT' || !create) throw new Error(`Özel giriş dosyası bulunamadı: ${credentials}. Mevcut şifreyi değiştirmemek için duruldu. Asıl dosyayı geri yükleyin veya bağlantısını onarın; mevcut kurulumda yeni anahtar üretmeyin.`);
    await mkdir(dirname(credentials), { recursive: true });
    const key = randomBytes(32).toString('base64url');
    text = `REVİR HEKİM GİRİŞİ\n\nHekim sayfası: Yayın adresinin sonuna /doktor ekleyin.\nGiriş şifresi: ${key}\n\nBu güçlü şifre yalnız hekim içindir. Bu dosyayı çalışanlarla veya kaynak paketiyle paylaşmayın.\nYerel v2 uygulamasının şifresi değişmedi.\n`;
    await writeFile(credentials, text, { mode: 0o600, flag: 'wx' });
  }
  await chmod(credentials, 0o600);
  const key = text.match(/^Giriş şifresi: ([A-Za-z0-9_-]+)\r?$/m)?.[1];
  if (!validKey(key)) throw new Error('Özel giriş dosyası geçersiz; mevcut şifreyi değiştirmeden duruldu.');
  return key;
}

export async function loadPepper(path = defaultPepperCredentials, { create = false } = {}) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Özel giriş anahtarı dosyası okunamadı; mevcut anahtar değiştirilmedi.');
    if (!create) throw new Error(`Özel giriş anahtarı dosyası bulunamadı: ${path}. Mevcut girişi değiştirmemek için duruldu. Asıl özel dosyayı geri yükleyin veya bağlantısını onarın.`);
    await mkdir(dirname(path), { recursive: true });
    value = { DOCTOR_KEY_PEPPER: randomBytes(32).toString('base64url') };
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  if (!validPepper(value?.DOCTOR_KEY_PEPPER)) throw new Error('Özel giriş anahtarı geçersiz; mevcut anahtar değiştirilmedi.');
  await chmod(path, 0o600);
  return value.DOCTOR_KEY_PEPPER;
}

export function doctorKeyHash(key, pepper) {
  if (!validKey(key) || !validPepper(pepper)) throw new Error('Giriş doğrulama bilgileri geçersiz.');
  return createHmac('sha256', Buffer.from(pepper, 'base64url'))
    .update('revir-doctor-password-v1\0' + key, 'utf8').digest('hex');
}

export async function prepareDoctorSecrets(credentials = defaultCredentials, { create = false, pepperPath = defaultPepperCredentials } = {}) {
  const key = await loadKey(credentials, create);
  const pepper = await loadPepper(pepperPath, { create });
  return { DOCTOR_KEY_HASH: doctorKeyHash(key, pepper), DOCTOR_KEY_PEPPER: pepper };
}

export async function prepareDeployment(credentials = defaultCredentials, {
  pepperPath = defaultPepperCredentials,
  pushCredentials,
  secretPath = resolve(root, '.wrangler/deploy-secrets.json'),
} = {}) {
  const doctor = await prepareDoctorSecrets(credentials, { pepperPath });
  await mkdir(dirname(secretPath), { recursive: true });
  const push = await preparePushSecrets(pushCredentials);
  await writeFile(secretPath, JSON.stringify({ ...doctor, ...push }), { mode: 0o600 });
  await chmod(secretPath, 0o600);
  return secretPath;
}

async function privateFileState(path) {
  try { await stat(path); return 'present'; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await lstat(path); return 'broken-link'; } catch { return 'missing'; }
  }
}

// Keys are created only on a deliberate first installation where none of the
// private files exist. A broken link or a partial set means an existing
// installation lost a file: recreating it would rotate live credentials.
async function assertFirstInstallAllowed(paths) {
  const states = await Promise.all(paths.map(privateFileState));
  const broken = paths.filter((_, index) => states[index] === 'broken-link');
  if (broken.length) throw new Error(`Özel dosya bağlantısı bozuk: ${broken.join(', ')}. Bağlantıyı onarın; yeni anahtar üretilmedi.`);
  if (states.includes('present') && states.includes('missing')) {
    const missing = paths.filter((_, index) => states[index] === 'missing');
    throw new Error(`Özel dosyaların bir kısmı eksik: ${missing.join(', ')}. Mevcut kurulumu bozmamak için yeni anahtar üretilmedi; asıl dosyaları geri yükleyin.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const credentialsIndex = args.indexOf('--credentials');
  const credentials = credentialsIndex >= 0 ? resolve(args[credentialsIndex + 1] || '') : defaultCredentials;
  const remaining = credentialsIndex >= 0 ? args.filter((_, index) => index !== credentialsIndex && index !== credentialsIndex + 1) : args;
  if (remaining.length !== 1 || !['--local', '--ilk-kurulum', '--prepare-deploy'].includes(remaining[0])
    || (credentialsIndex >= 0 && !args[credentialsIndex + 1])) {
    throw new Error('Kullanım: node scripts/setup-doctor-key.mjs --local, --ilk-kurulum veya --prepare-deploy [--credentials DOSYA]');
  }
  if (remaining[0] === '--local' || remaining[0] === '--ilk-kurulum') {
    // --local only reuses existing private files; --ilk-kurulum may create them.
    const create = remaining[0] === '--ilk-kurulum';
    if (create) await assertFirstInstallAllowed([credentials, defaultPepperCredentials, defaultPushCredentials]);
    const doctor = await prepareDoctorSecrets(credentials, { create });
    const localPath = resolve(root, '.dev.vars');
    let previous = '';
    try { previous = await readFile(localPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const rest = previous.split('\n').filter(line => !/^\s*(?:DOCTOR_KEY_HASH|DOCTOR_KEY_PEPPER|VAPID_PRIVATE_KEY|VAPID_PUBLIC_KEY|VAPID_SUBJECT)\s*=/.test(line)).join('\n').trim();
    const push = await preparePushSecrets(undefined, { create });
    const variables = Object.entries({ ...doctor, ...push }).map(([name, secret]) => `${name}=${JSON.stringify(secret)}`).join('\n');
    await writeFile(localPath, `${rest ? rest + '\n' : ''}${variables}\n`, { mode: 0o600 });
    await chmod(localPath, 0o600);
    console.log(`Yerel hekim girişi hazır. Özel giriş dosyası: ${credentials}`);
  } else {
    await prepareDeployment(credentials);
    console.log('Giriş doğrulama bilgisi özel yayın dosyasında hazırlandı; internete gönderilmedi.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
