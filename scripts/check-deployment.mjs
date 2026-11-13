import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkDeployment() {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const db = config.d1_databases?.find(binding => binding.binding === 'DB');
  const valid = db && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id)
    && !/^0{8}-/.test(db.database_id) && config.assets?.run_worker_first === true
    && config.secrets?.required?.includes('DOCTOR_KEY_HASH')
    && ['DOCTOR_KEY_PEPPER', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT'].every(name => config.secrets?.required?.includes(name))
    && !Object.hasOwn(config.vars || {}, 'DOCTOR_KEY_HASH')
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.vars?.DOCTOR_EMAIL || '');
  if (!valid) throw new Error('Yayın durduruldu: gerçek D1 ve hekim giriş yapılandırması tamamlanmalı.');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { checkDeployment(); console.log('Yayın yapılandırması tamam.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
