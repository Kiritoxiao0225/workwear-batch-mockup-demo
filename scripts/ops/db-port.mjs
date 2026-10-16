// Usage: node scripts/ops/db-port.mjs [status|open|close]
// The production database has no public port (closed 2026-10-16). Web and workers reach it on the
// Zeabur internal network; only a migration run from this machine needs it, so it is opened for
// that run and closed again (docs/database.md §6).
import { readFile } from 'node:fs/promises';
import { platformQuery } from './zeabur-api.mjs';

const contract = JSON.parse(await readFile(new URL('./production-contract.json', import.meta.url), 'utf8'));
const ids = { s: contract.database.service, e: contract.environment };
const state = async () => (await platformQuery('query($s:ObjectID!,$e:ObjectID!){service(_id:$s){portForwardedHost portForwardingMode(environmentID:$e) ports(environmentID:$e){id port forwardedPort}}}', ids)).service;
const show = s => console.log(`公网端口：${s.portForwardingMode === 'ENABLED' ? '开' : '关'}`
  + (s.portForwardingMode === 'ENABLED' ? `，${s.portForwardedHost}:${s.ports.find(p => p.port === 5432)?.forwardedPort}` : ''));

const command = process.argv[2] ?? 'status';
if (!['status', 'open', 'close'].includes(command)) throw new Error('用法：node scripts/ops/db-port.mjs [status|open|close]');
if (command !== 'status') {
  await platformQuery('mutation($s:ObjectID!,$e:ObjectID!,$m:PortForwardingMode!){updatePortForwardingMode(serviceID:$s,environmentID:$e,mode:$m)}', { ...ids, m: command === 'open' ? 'ENABLED' : 'DISABLED' });
}
const now = await state();
show(now);
if (command === 'open') console.log('端口号可能和上次不同：核对 .env.local 与 .env.catalog-admin.local 里的地址，迁移跑完立刻 close。');
