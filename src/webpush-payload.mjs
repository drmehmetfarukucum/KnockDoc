// RFC 8291 / RFC 8188: one aes128gcm record, browser-owned subscription keys.
// Only anonymous visit codes or a generic feedback event enter this channel;
// no employee text is serialized.
const encoder = new TextEncoder();
// Preserve queued notifications produced before the readable weekday update.
const weekdays = [['Pzr', 'Paz'], ['Pzt'], ['Salı', 'Sal'], ['Çarş', 'Çar'], ['Perş', 'Per'], ['Cuma', 'Cum'], ['Cmt']];

export function canonicalBase64url(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid push key');
  const raw = value.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(raw + '='.repeat((4 - raw.length % 4) % 4)), character => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  if (bytes.length !== length || canonical !== value) throw new Error('Invalid push key');
  return bytes;
}

export function validatePayloadKeys(keys) {
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('Invalid push keys');
  const publicBytes = canonicalBase64url(keys.p256dh, 65);
  canonicalBase64url(keys.auth, 16);
  if (publicBytes[0] !== 4) throw new Error('Invalid push key');
  return { p256dh: keys.p256dh, auth: keys.auth };
}

export async function importPayloadPublicKey(p256dh) {
  const bytes = canonicalBase64url(p256dh, 65);
  if (bytes[0] !== 4) throw new Error('Invalid push key');
  // WebCrypto rejects infinity, out-of-range coordinates, and points off P-256.
  return crypto.subtle.importKey('raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export function encodePushEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid push event');
  if (event.type === 'feedback') return encoder.encode(JSON.stringify({ v: 1, type: 'feedback' }));
  if (!['new', 'waiting', 'left', 'message'].includes(event.type)
    || typeof event.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(event.day)
    || typeof event.code !== 'string') throw new Error('Invalid push event');
  const date = new Date(`${event.day}T00:00:00.000Z`);
  const code = /^(Pzt|Salı|Sal|Çarş|Çar|Perş|Per|Cuma|Cum|Cmt|Pzr|Paz)-([1-9]\d{0,14})$/.exec(event.code);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== event.day
    || !code || !weekdays[date.getUTCDay()].includes(code[1])) throw new Error('Invalid push event');
  return encoder.encode(JSON.stringify({ v: 1, type: event.type, code: event.code, day: event.day }));
}

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

async function hkdf(material, salt, info, bits) {
  const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

/** Deterministic options exist solely for published-vector tests; callers omit them. */
export async function encryptWebPush(plaintext, subscription, { salt: fixedSalt, ephemeralKeyPair } = {}) {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > 3993) throw new Error('Invalid push payload');
  const keys = validatePayloadKeys(subscription);
  const receiverBytes = canonicalBase64url(keys.p256dh, 65);
  const receiverKey = await importPayloadPublicKey(keys.p256dh);
  const auth = canonicalBase64url(keys.auth, 16);
  const sender = ephemeralKeyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderBytes = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  if (senderBytes.byteLength !== 65 || senderBytes[0] !== 4) throw new Error('Invalid sender key');
  const salt = fixedSalt === undefined ? crypto.getRandomValues(new Uint8Array(16)) : new Uint8Array(fixedSalt);
  if (salt.byteLength !== 16) throw new Error('Invalid push salt');
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, sender.privateKey, 256);
  const info = concat(encoder.encode('WebPush: info\0'), receiverBytes, senderBytes);
  const ikm = await hkdf(shared, auth, info, 256);
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 96);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(86);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(senderBytes, 21);
  return concat(header, ciphertext);
}
