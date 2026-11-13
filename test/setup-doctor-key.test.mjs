import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, stat, rm, mkdir, copyFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKey, loadPepper, doctorKeyHash, prepareDoctorSecrets, prepareDeployment } from '../scripts/setup-doctor-key.mjs';
import { preparePushSecrets } from '../scripts/setup-push-key.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'revir-doctor-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    credentials: join(directory, 'credentials.txt'),
    pepperPath: join(directory, 'pepper.json'),
    pushCredentials: join(directory, 'push.json'),
    secretPath: join(directory, 'deploy.json'),
  };
}

test('new installations still generate a private 256-bit random password', async t => {
  const f = await fixture(t);
  const key = await loadKey(f.credentials, true);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(key, 'base64url').length, 32);
  assert.equal((await stat(f.credentials)).mode & 0o777, 0o600);
  assert.equal(await loadKey(f.credentials, true), key);
});

test('configured six-digit PIN is accepted without changing its private file', async t => {
  const f = await fixture(t);
  const text = 'REVİR HEKİM GİRİŞİ\nGiriş şifresi: 731942\n';
  await writeFile(f.credentials, text);
  assert.equal(await loadKey(f.credentials), '731942');
  assert.equal(await readFile(f.credentials, 'utf8'), text);
  await writeFile(f.credentials, 'Giriş şifresi: 73194\n');
  await assert.rejects(loadKey(f.credentials), /geçersiz/);
});

test('persistent private pepper and domain-separated HMAC remain stable across preparations', async t => {
  const f = await fixture(t);
  await writeFile(f.credentials, 'Giriş şifresi: 731942\n');
  const first = await prepareDoctorSecrets(f.credentials, { ...f, create: true });
  const pepperText = await readFile(f.pepperPath, 'utf8');
  const second = await prepareDoctorSecrets(f.credentials, f);
  assert.deepEqual(second, first);
  assert.equal(await readFile(f.pepperPath, 'utf8'), pepperText);
  assert.equal((await stat(f.pepperPath)).mode & 0o777, 0o600);
  const expected = createHmac('sha256', Buffer.from(first.DOCTOR_KEY_PEPPER, 'base64url'))
    .update('revir-doctor-password-v1\0' + '731942', 'utf8').digest('hex');
  assert.equal(first.DOCTOR_KEY_HASH, expected);
  assert.match(first.DOCTOR_KEY_HASH, /^[a-f0-9]{64}$/);
  assert.notEqual(doctorKeyHash('731943', first.DOCTOR_KEY_PEPPER), expected);
});

test('malformed existing pepper files fail closed and keep their exact content', async t => {
  const f = await fixture(t);
  for (const malformed of ['{', '{}', 'null', '{"DOCTOR_KEY_PEPPER":"bad"}', '{"DOCTOR_KEY_PEPPER":42}']) {
    await writeFile(f.pepperPath, malformed);
    await assert.rejects(loadPepper(f.pepperPath), /okunamadı|geçersiz/);
    assert.equal(await readFile(f.pepperPath, 'utf8'), malformed);
  }
});

test('deployment merges doctor secrets and preserves existing notification keys', async t => {
  const f = await fixture(t);
  await loadKey(f.credentials, true);
  await prepareDoctorSecrets(f.credentials, { ...f, create: true });
  await preparePushSecrets(f.pushCredentials, { create: true });
  assert.equal(await prepareDeployment(f.credentials, f), f.secretPath);
  const first = JSON.parse(await readFile(f.secretPath, 'utf8'));
  const push = JSON.parse(await readFile(f.pushCredentials, 'utf8'));
  assert.deepEqual(first, { ...await prepareDoctorSecrets(f.credentials, f), ...push });
  assert.equal((await stat(f.secretPath)).mode & 0o777, 0o600);
  await prepareDeployment(f.credentials, f);
  assert.deepEqual(JSON.parse(await readFile(f.secretPath, 'utf8')), first);
  assert.deepEqual(JSON.parse(await readFile(f.pushCredentials, 'utf8')), push);
});

test('deployment refuses missing doctor pepper without replacing private or prepared files', async t => {
  const f = await fixture(t);
  await loadKey(f.credentials, true);
  const before = await readFile(f.credentials, 'utf8');
  await writeFile(f.secretPath, 'existing prepared secrets');
  await assert.rejects(prepareDeployment(f.credentials, f), /bulunamadı/);
  assert.equal(await readFile(f.credentials, 'utf8'), before);
  assert.equal(await readFile(f.secretPath, 'utf8'), 'existing prepared secrets');
  await assert.rejects(stat(f.pepperPath), { code: 'ENOENT' });
  await assert.rejects(stat(f.pushCredentials), { code: 'ENOENT' });
});

test('deployment refuses missing notification keys instead of silently rotating subscriptions', async t => {
  const f = await fixture(t);
  await prepareDoctorSecrets(f.credentials, { ...f, create: true });
  const pepper = await readFile(f.pepperPath, 'utf8');
  await writeFile(f.secretPath, 'existing prepared secrets');
  await assert.rejects(prepareDeployment(f.credentials, f), /bulunamadı/);
  assert.equal(await readFile(f.pepperPath, 'utf8'), pepper);
  assert.equal(await readFile(f.secretPath, 'utf8'), 'existing prepared secrets');
  await assert.rejects(stat(f.pushCredentials), { code: 'ENOENT' });
});

// The scripts find private files relative to their own folder. Run real copies
// from a moved application folder (<tmp>/a/app/scripts → <tmp>/work), as happens
// when the source is copied elsewhere without its private files.
async function movedInstall(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'revir-moved-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, 'a', 'app');
  await mkdir(join(app, 'scripts'), { recursive: true });
  for (const name of ['setup-doctor-key.mjs', 'setup-push-key.mjs']) {
    await copyFile(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(app, 'scripts', name));
  }
  const work = join(directory, 'work');
  const files = ['revir-cloudflare-giris.txt', 'revir-doctor-pepper.json', 'revir-push-anahtarlari.json'].map(name => join(work, name));
  const run = async flag => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [join(app, 'scripts', 'setup-doctor-key.mjs'), flag], { cwd: app });
      return { code: 0, output: stdout };
    } catch (error) { return { code: error.code, output: `${error.stdout}${error.stderr}` }; }
  };
  const read = paths => Promise.all(paths.map(path => readFile(path, 'utf8')));
  return { work, files, run, read, devVars: join(app, '.dev.vars') };
}

test('moved folder: --local and deploy preparation stop without creating keys or suggesting it', async t => {
  const m = await movedInstall(t);
  for (const flag of ['--local', '--prepare-deploy']) {
    const result = await m.run(flag);
    assert.notEqual(result.code, 0, flag);
    assert.match(result.output, /bulunamadı/);
    assert.doesNotMatch(result.output, /--local|--ilk-kurulum/);
  }
  await assert.rejects(stat(m.work), { code: 'ENOENT' });
  await assert.rejects(stat(m.devVars), { code: 'ENOENT' });
});

test('--ilk-kurulum creates all private keys once; later runs reuse them unchanged', async t => {
  const m = await movedInstall(t);
  const created = await m.run('--ilk-kurulum');
  assert.equal(created.code, 0, created.output);
  const contents = await m.read(m.files);
  for (const file of m.files) assert.equal((await stat(file)).mode & 0o777, 0o600);
  const devVars = await readFile(m.devVars, 'utf8');
  for (const name of ['DOCTOR_KEY_HASH', 'DOCTOR_KEY_PEPPER', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']) {
    assert.match(devVars, new RegExp(`^${name}=`, 'm'));
  }
  for (const flag of ['--local', '--ilk-kurulum']) {
    assert.equal((await m.run(flag)).code, 0, flag);
    assert.deepEqual(await m.read(m.files), contents);
    assert.equal(await readFile(m.devVars, 'utf8'), devVars);
  }
});

test('a missing file or broken link stops every setup mode and replaces nothing', async t => {
  const m = await movedInstall(t);
  assert.equal((await m.run('--ilk-kurulum')).code, 0);
  const [credentials, pepper, push] = m.files;
  const kept = await m.read([credentials, push]);
  const devVars = await readFile(m.devVars, 'utf8');
  await rm(pepper);
  let result = await m.run('--ilk-kurulum');
  assert.notEqual(result.code, 0);
  assert.match(result.output, /bir kısmı eksik/);
  assert.equal((await m.run('--local')).code === 0, false);
  await assert.rejects(stat(pepper), { code: 'ENOENT' });
  const target = join(m.work, 'kayip-hedef.json');
  await symlink(target, pepper);
  result = await m.run('--ilk-kurulum');
  assert.notEqual(result.code, 0);
  assert.match(result.output, /bağlantısı bozuk/);
  result = await m.run('--local');
  assert.notEqual(result.code, 0);
  assert.match(result.output, /bulunamadı.*bağlantısını onarın/s);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  assert.deepEqual(await m.read([credentials, push]), kept);
  assert.equal(await readFile(m.devVars, 'utf8'), devVars);
});
