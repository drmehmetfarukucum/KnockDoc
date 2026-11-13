import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDeployment } from './check-deployment.mjs';
import { prepareDeployment } from './setup-doctor-key.mjs';

try {
  checkDeployment();
  const secrets = await prepareDeployment();
  // Code, assets and the required secret are uploaded in the same version.
  const executable = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
  const child = spawn(executable, ['deploy', '--secrets-file', secrets], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', shell: false,
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
