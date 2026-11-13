import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, hkdfSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { record } from '../src/rules.mjs';
import { canonicalBase64url, encodePushEvent, encryptWebPush, importPayloadPublicKey, validatePayloadKeys } from '../src/webpush-payload.mjs';

const b64 = bytes => Buffer.from(bytes).toString('base64url');
const unb64 = value => Buffer.from(value, 'base64url');
const encoder = new TextEncoder();
// Published interoperability vector, RFC 8291 section 5 and Appendix A:
// https://www.rfc-editor.org/rfc/rfc8291#section-5
const vector = {
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  ciphertext: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// Independent receiver uses Node/OpenSSL ECDH, HKDF and AES rather than any
// production derivation helper or WebCrypto decrypt operation.
function decryptAtReceiver(message, privateKey, auth) {
  const bytes = Buffer.from(message);
  assert.equal(bytes.readUInt32BE(16), 4096);
  assert.equal(bytes[20], 65);
  const salt = bytes.subarray(0, 16);
  const senderPublic = bytes.subarray(21, 86);
  const ciphertext = bytes.subarray(86);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(unb64(privateKey));
  const shared = receiver.computeSecret(senderPublic);
  const ikm = hkdfSync('sha256', shared, unb64(auth), Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic]), 32);
  const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const clear = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  let last = clear.length - 1;
  while (clear[last] === 0) last--;
  assert.equal(clear[last], 2, 'a single final record must use delimiter 0x02');
  return clear.subarray(0, last);
}

async function senderPair() {
  const raw = unb64(vector.senderPublic);
  const publicKey = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const privateKey = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)), d: vector.senderPrivate,
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { publicKey, privateKey };
}

test('RFC 8291 published encryption vector matches every output byte and independent receiver decrypts it', async () => {
  const plaintext = encoder.encode('When I grow up, I want to be a watermelon');
  const encrypted = await encryptWebPush(plaintext, { p256dh: vector.receiverPublic, auth: vector.auth }, {
    salt: unb64(vector.salt), ephemeralKeyPair: await senderPair(),
  });
  assert.equal(b64(encrypted), vector.ciphertext);
  assert.equal(encrypted.byteLength, unb64(vector.ciphertext).byteLength);
  assert.equal(decryptAtReceiver(encrypted, vector.receiverPrivate, vector.auth).toString(), new TextDecoder().decode(plaintext));
});

test('real coded events decrypt independently; each send uses a fresh salt and ephemeral key without readable code on wire', async () => {
  const plaintext = encodePushEvent({ type: 'message', code: 'Cuma-19', day: '2026-10-16', note: 'private text must not serialize', phone: 'private phone', fullName: 'private name', text: 'private message' });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), { v: 1, type: 'message', code: 'Cuma-19', day: '2026-10-16' });
  const keys = { p256dh: vector.receiverPublic, auth: vector.auth };
  const first = await encryptWebPush(plaintext, keys);
  const second = await encryptWebPush(plaintext, keys);
  assert.notEqual(b64(first.subarray(0, 16)), b64(second.subarray(0, 16)));
  assert.notEqual(b64(first.subarray(21, 86)), b64(second.subarray(21, 86)));
  assert.deepEqual(decryptAtReceiver(first, vector.receiverPrivate, vector.auth), Buffer.from(plaintext));
  assert.deepEqual(decryptAtReceiver(second, vector.receiverPrivate, vector.auth), Buffer.from(plaintext));
  for (const secret of ['Cuma-19', 'message', '2026-10-16', 'private text', 'private phone', 'private name', 'private message']) assert.equal(Buffer.from(first).includes(Buffer.from(secret)), false);
});

test('feedback has no visitor code or date and independently decrypts to a generic event with no employee content', async () => {
  const input = { type: 'feedback', text: 'private feedback', category: 'bug', fullName: 'private name', phone: 'private phone', code: 'Cuma-19', day: '2026-10-16' };
  const plaintext = encodePushEvent(input);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), { v: 1, type: 'feedback' });
  const encrypted = await encryptWebPush(plaintext, { p256dh: vector.receiverPublic, auth: vector.auth });
  assert.deepEqual(JSON.parse(decryptAtReceiver(encrypted, vector.receiverPrivate, vector.auth)), { v: 1, type: 'feedback' });
  for (const value of Object.values(input)) assert.equal(Buffer.from(encrypted).includes(Buffer.from(value)), false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encodePushEvent({ type: 'feedback' }))), { v: 1, type: 'feedback' });
});

test('tampered ciphertext, auth secret, salt and ephemeral point fail at the independent receiver', async () => {
  const encrypted = await encryptWebPush(encoder.encode('test'), { p256dh: vector.receiverPublic, auth: vector.auth });
  for (const offset of [0, 21, encrypted.length - 1]) {
    const altered = Buffer.from(encrypted); altered[offset] ^= 1;
    assert.throws(() => decryptAtReceiver(altered, vector.receiverPrivate, vector.auth));
  }
  assert.throws(() => decryptAtReceiver(encrypted, vector.receiverPrivate, b64(new Uint8Array(16))));
});

test('payload keys require canonical base64url, exact sizes, uncompressed form and a real P-256 point', async () => {
  const valid = { p256dh: vector.receiverPublic, auth: vector.auth };
  assert.deepEqual(validatePayloadKeys(valid), valid);
  await importPayloadPublicKey(valid.p256dh);
  for (const keys of [null, [], {}, { ...valid, auth: valid.auth + '=' }, { ...valid, auth: b64(new Uint8Array(15)) },
    { ...valid, auth: 'A'.repeat(21) + 'B' }, { ...valid, p256dh: b64(new Uint8Array(65)) }, { ...valid, p256dh: b64(new Uint8Array(33)) }]) {
    assert.throws(() => validatePayloadKeys(keys));
  }
  const offCurve = new Uint8Array(65); offCurve[0] = 4;
  await assert.rejects(importPayloadPublicKey(b64(offCurve)));
  assert.throws(() => canonicalBase64url('!', 1));
  await assert.rejects(encryptWebPush(new Uint8Array(3994), valid));
});

test('all seven backend-generated readable Turkish visitor codes encode all four event types', () => {
  const expected = ['Pzt', 'Salı', 'Çarş', 'Perş', 'Cuma', 'Cmt', 'Pzr'];
  for (let index = 0; index < 7; index++) {
    const day = `2026-10-${String(12 + index).padStart(2, '0')}`;
    const row = record({ id: 'test', created: Date.parse(`${day}T09:00:00Z`), expires: Date.parse(`${day}T10:00:00Z`), status: 'new',
      note: '', phone: '', full_name: '', reply: '', replied: null, completed: null, version: 1, created_day: day, visitor_number: 19 });
    assert.equal(row.visitorCode, `${expected[index]}-19`);
    for (const type of ['new', 'waiting', 'left', 'message']) assert.deepEqual(JSON.parse(new TextDecoder().decode(encodePushEvent({ type, code: row.visitorCode, day: row.visitorDay }))), { v: 1, type, code: row.visitorCode, day: row.visitorDay });
  }
});

test('encoder accepts queued legacy weekday codes but rejects wrong weekdays, invalid dates and malformed numbers', () => {
  for (const [index, prefix] of ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].entries()) {
    const day = `2026-10-${12 + index}`;
    for (const type of ['new', 'waiting', 'left', 'message']) assert.deepEqual(JSON.parse(new TextDecoder().decode(encodePushEvent({ type, code: `${prefix}-19`, day }))), { v: 1, type, code: `${prefix}-19`, day });
  }
  for (const event of [null, {}, { type: 'arbitrary', code: 'Cuma-19', day: '2026-10-16' }, { type: 'message', code: 'Pzt-19', day: '2026-10-16' },
    { type: 'new', code: 'Cuma-0', day: '2026-10-16' }, { type: 'new', code: 'Cuma-019', day: '2026-10-16' },
    { type: 'new', code: 'Cuma-19', day: '2026-02-30' }, { type: 'new', code: 'Cum-19', day: '2026-10-17' },
    { type: 'new', code: 'Salı-19', day: '2026-10-16' }, { type: 'new', code: 'Pzr-19', day: '2026-10-17' },
    { type: 'new', code: '<script>', day: '2026-10-16' }]) assert.throws(() => encodePushEvent(event));
});

async function notification(payload, throws = false) {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map(); const shown = [];
  const context = vm.createContext({ self: {
    addEventListener: (name, handler) => listeners.set(name, handler),
    registration: { showNotification: async (title, options) => shown.push({ title, ...options }) },
  } });
  vm.runInContext(source, context);
  let pending;
  listeners.get('push')({
    get data() { if (throws) throw new Error('bad payload'); return payload === undefined ? null : { json: () => payload }; },
    waitUntil(value) { pending = value; },
  });
  await pending;
  return JSON.parse(JSON.stringify(shown[0]));
}

test('service worker derives all four coded notifications for all seven readable weekdays with fixed physician destination', async () => {
  for (const [index, prefix] of ['Pzt', 'Salı', 'Çarş', 'Perş', 'Cuma', 'Cmt', 'Pzr'].entries()) {
    const day = `2026-10-${12 + index}`, code = `${prefix}-19`;
    for (const [type, words] of [['new', 'yeni geliş bildirdi'], ['waiting', 'bekliyor'], ['left', 'ayrıldı, sonra gelecek'], ['message', 'hekime not iletti']]) {
      const result = await notification({ v: 1, type, code, day });
      assert.equal(result.title, 'Revir Haberleşme');
      assert.equal(result.body, `${code} ${words}. (${12 + index}.10)`);
      assert.deepEqual(result.data, { url: '/doktor' });
      assert.equal(result.tag, `revir-${day}-${code}`);
      assert.equal(result.renotify, true);
      assert.equal(result.silent, false);
    }
  }
});

test('service worker continues accepting queued legacy prefixes with matching weekdays', async () => {
  for (const [index, prefix] of ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].entries()) {
    const day = `2026-10-${12 + index}`, code = `${prefix}-19`;
    const result = await notification({ v: 1, type: 'waiting', code, day });
    assert.equal(result.body, `${code} bekliyor. (${12 + index}.10)`);
    assert.deepEqual(result.data, { url: '/doktor' });
  }
});

test('service worker displays generic feedback with a fixed feedback destination and no identifying content', async () => {
  const result = await notification({ v: 1, type: 'feedback' });
  assert.equal(result.title, 'Revir Haberleşme');
  assert.equal(result.body, 'Yeni bir uygulama görüşü var.');
  assert.deepEqual(result.data, { url: '/doktor#doctor-feedback-details' });
  assert.equal(result.tag, 'revir-feedback');
  assert.equal(result.renotify, true);
  assert.equal(result.silent, false);
});

test('legacy, malformed or untrusted service worker payloads retain generic text without using arbitrary body/title/url or private message content', async () => {
  const valid = { v: 1, type: 'message', code: 'Cuma-19', day: '2026-10-16' };
  for (const payload of [undefined, null, [], {}, { ...valid, v: 2 }, { ...valid, type: 'urgent' }, { ...valid, code: 'Pzt-19' },
    { ...valid, code: 'Cuma-0' }, { ...valid, day: '2026-02-30' }, { ...valid, code: 'Salı-19' }, { ...valid, code: 'Cum-19', day: '2026-10-17' },
    { ...valid, text: 'private message' }, { ...valid, note: 'private note', phone: 'private phone', fullName: 'private name' },
    { v: 1, type: 'feedback', text: 'private feedback' }, { v: 1, type: 'feedback', code: 'Cuma-19', day: '2026-10-16' },
    { v: 1, type: 'feedback', url: 'https://evil.test' },
    { ...valid, body: 'private disease', title: 'arbitrary', url: 'https://evil.test/' }]) {
    const result = await notification(payload);
    assert.equal(result.body, 'Yeni geliş, mesaj, görüş veya bekleme durumu güncellemesi var.');
    assert.equal(result.silent, false);
    assert.deepEqual(result.data, { url: '/doktor' });
    assert.equal(Object.hasOwn(result, 'tag'), false);
  }
  assert.equal((await notification(null, true)).body, 'Yeni geliş, mesaj, görüş veya bekleme durumu güncellemesi var.');
});

test('feedback notification clicks message an existing physician page without navigating away from drafts and use a fixed destination for a new window', async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const data of [{ url: '/doktor#doctor-feedback-details' }, { url: 'https://evil.test/' }, { url: '/other' }, undefined]) {
    for (const existing of [true, false]) {
      const listeners = new Map(), events = [];
      const client = { url: 'https://revir.example.test/doktor#doctor-feedback-details', navigate: async url => events.push(['navigate', url]), postMessage: message => events.push(['message', JSON.parse(JSON.stringify(message))]), focus: async () => events.push(['focus']) };
      vm.runInContext(source, vm.createContext({ URL, self: {
        location: { origin: 'https://revir.example.test' },
        addEventListener: (name, handler) => listeners.set(name, handler),
        clients: { matchAll: async () => existing ? [client] : [], openWindow: async url => events.push(['open', url]) },
      } }));
      let pending;
      listeners.get('notificationclick')({ notification: { data, close() { events.push(['close']); } }, waitUntil(value) { pending = value; } });
      await pending;
      const destination = data?.url === '/doktor#doctor-feedback-details' ? '/doktor#doctor-feedback-details' : '/doktor';
      assert.deepEqual(events, existing
        ? [['close'], ...(destination !== '/doktor' ? [['message', { type: 'revir-open-feedback' }]] : []), ['focus']]
        : [['close'], ['open', destination]]);
      if (existing && destination !== '/doktor') {
        listeners.get('notificationclick')({ notification: { data, close() { events.push(['close']); } }, waitUntil(value) { pending = value; } });
        await pending;
        assert.deepEqual(events.slice(3), [['close'], ['message', { type: 'revir-open-feedback' }], ['focus']], 'another click refreshes the already open section');
      }
    }
  }
});

test('notification clicks select only the two supported physician paths instead of unrelated prefix-matching pages', async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  for (const path of ['/doktor', '/doktor/', null]) {
    const listeners = new Map(), events = [];
    const client = (url, label) => ({ url, focus: async () => events.push(['focus', label]) });
    const windows = [client('https://revir.example.test/doktor-eski', 'wrong-prefix'), client('https://foreign.example/doktor', 'foreign-origin')];
    if (path) windows.push(client('https://revir.example.test' + path, 'physician'));
    vm.runInContext(source, vm.createContext({ URL, self: {
      location: { origin: 'https://revir.example.test' },
      addEventListener: (name, handler) => listeners.set(name, handler),
      clients: { matchAll: async () => windows, openWindow: async url => events.push(['open', url]) },
    } }));
    let pending;
    listeners.get('notificationclick')({ notification: { close() {} }, waitUntil(value) { pending = value; } });
    await pending;
    assert.deepEqual(events, path ? [['focus', 'physician']] : [['open', '/doktor']]);
  }
});

test('service worker update activates without waiting for an old physician page to close', async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map(); let activated = 0; let pending;
  vm.runInContext(source, vm.createContext({ self: {
    addEventListener: (name, handler) => listeners.set(name, handler),
    skipWaiting: async () => { activated++; },
  } }));
  listeners.get('install')({ waitUntil(value) { pending = value; } });
  await pending;
  assert.equal(activated, 1);
  assert.equal(listeners.has('fetch'), false);
});
