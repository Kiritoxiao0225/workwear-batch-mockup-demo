import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
process.loadEnvFile('.env.local');
if (process.env.WPS_PRODUCTION_STORAGE !== 'cloud' || process.env.CATALOG_LOCAL_OBJECT_ROOT) throw new Error('云端运行配置不完整或仍指定本地对象库');
mkdirSync('output/runtime', { recursive: true });
const children = [];
for (const [name, args] of [
  ['production-web', ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3000']],
]) {
  const log = openSync(`output/runtime/${name}.log`, 'a');
  const child = spawn(process.execPath, args, { stdio: ['ignore', log, log], env: { ...process.env, CATALOG_NEXT_DIST_DIR: '.next-production-cloud' } });
  children.push(child);
  writeFileSync(`output/runtime/${name}.pid`, String(child.pid));
  child.on('error', error => { console.error(error.message); stop(); });
  child.on('exit', () => stop());
}
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
