import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { platformQuery } from './zeabur-api.mjs';
export const contract = JSON.parse(await readFile(new URL('./production-contract.json', import.meta.url), 'utf8'));
export function validateDatabase(service, guard) {
 const expected = contract.database;
 const variables = Object.fromEntries(service.variables.map(v => [v.key, v.value]));
 assert.equal(service.spec.source.image, expected.image, 'Database specification image drift');
 assert.equal(service.image.reference, expected.image, 'Database runtime image drift');
 assert.deepEqual(service.spec.volumes, [expected.volume], 'Database volume drift');
 assert.equal(variables.PGDATA, expected.dataDirectory, 'Database PGDATA drift');
 assert.equal(variables.PG_EXPECTED_SYSTEM_IDENTIFIER, expected.systemIdentifier, 'Database cluster identity drift');
 assert.deepEqual(service.spec.source.command, expected.command, 'Database startup command drift');
 assert.deepEqual(service.spec.source.args, expected.args, 'Database startup arguments drift');
 assert.equal(service.configInfo.content, guard, 'Database guard source drift');
 assert.equal(service.configInfo.envsubst, false, 'Database guard env substitution must stay disabled');
}
export async function productionPreflight({ databaseOnly = false } = {}) {
 const { service } = await platformQuery('query($s:ObjectID!,$e:ObjectID!,$p:String!){service(_id:$s){spec{source{image command args} volumes{id dir}} image(environmentID:$e){reference} variables(environmentID:$e){key value} configInfo(environmentID:$e,path:$p){content envsubst}}}', { s: contract.database.service, e: contract.environment, p: contract.database.guardPath });
 validateDatabase(service, await readFile(new URL('./postgres-start-guard.sh', import.meta.url), 'utf8'));
 const guard = await platformQuery('mutation($s:ObjectID!,$e:ObjectID!,$c:[String!]!){executeCommand(serviceID:$s,environmentID:$e,command:$c){exitCode output}}', {
  s: contract.database.service, e: contract.environment, c: ['sh', '-lc', 'PG_GUARD_CHECK_ONLY=1 sh /etc/pg-guard/start.sh'],
 });
 assert.equal(guard.executeCommand.exitCode, 0, 'Database runtime storage guard rejected configuration');
 if (!databaseOnly) for (const [scope, expected] of Object.entries(contract.workers)) {
  const { service } = await platformQuery('query($s:ObjectID!,$e:ObjectID!){service(_id:$s){variables(environmentID:$e){key value}}}', { s: expected.service, e: contract.environment });
  const variables = Object.fromEntries(service.variables.map(v => [v.key, v.value]));
  assert.equal(variables.BATCH_WORKER_SCOPE, scope, 'Worker scope drift');
  assert.equal(Number(variables.BATCH_WORKER_CONCURRENCY), expected.concurrency, 'Worker concurrency drift');
  assert.equal(Number(variables.BATCH_WORKER_RSS_PAUSE_MB), expected.rssPauseMB, 'Worker RSS guard drift');
  assert.equal(Number(variables.BATCH_WORKER_HOST_RESERVE_MB), expected.hostReserveMB, 'Worker host reserve drift');
 }
 return { checkedAt: new Date().toISOString(), database: 'verified', workers: databaseOnly ? 'not_checked' : 'verified' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try { console.log(JSON.stringify(await productionPreflight({ databaseOnly: process.argv.includes('--database-only') }))); }
 catch (error) { console.error(error.message); process.exitCode = 1; }
}
