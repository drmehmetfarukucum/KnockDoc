import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultPushCredentials = fileURLToPath(new URL('../../../work/revir-push-anahtarlari.json', import.meta.url));

// Keep the same signing key across releases: changing it invalidates existing subscriptions.
export async function preparePushSecrets(path = defaultPushCredentials, { create = false } = {}) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Özel bildirim anahtarı dosyası okunamadı; mevcut anahtar değiştirilmedi.');
    if (!create) throw new Error(`Özel bildirim anahtarı dosyası bulunamadı: ${path}. Cihaz bağlantılarını korumak için duruldu. Asıl özel dosyayı geri yükleyin veya bağlantısını onarın.`);
    await mkdir(dirname(path), { recursive: true });
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    value = {
      VAPID_PRIVATE_KEY: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
      VAPID_SUBJECT: 'mailto:hekim@ornek-kurum.example',
    };
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(value.VAPID_PRIVATE_KEY, 'base64url'), format: 'der', type: 'pkcs8' });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    if (jwk.crv !== 'P-256' || publicKey !== value.VAPID_PUBLIC_KEY || value.VAPID_SUBJECT !== 'mailto:hekim@ornek-kurum.example') throw new Error();
  } catch { throw new Error('Özel bildirim anahtarı doğrulanamadı; yayın durduruldu.'); }
  await chmod(path, 0o600);
  return value;
}
