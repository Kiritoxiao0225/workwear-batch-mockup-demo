// Queue claim rules against a real PostgreSQL: one requirement's artworks may generate side by side
// and its mock-up renders alongside them, two mock-ups and anything beside a reading wait, a second
// waiting mock-up is never queued, and a worker never exceeds its concurrency.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

const root = await mkdtemp(join(tmpdir(), 'batch-claim-')), probe = createServer();
await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
const password = randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL = `postgresql://claim:${password}@127.0.0.1:${port}/postgres`; process.env.CATALOG_DATABASE_CA_CERT = '';
const database = new EmbeddedPostgres({ databaseDir: join(root, 'pg'), user: 'claim', password, port, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: e => console.error(e.name || 'db error') });
const { catalogDatabase: db, closeCatalogDatabase, migrateCatalog } = await import('../lib/server/catalog-database.ts');
const { claimNextTask, workerConcurrency, startBatchWorker } = await import('../batch-mockup/runtime/worker.mjs');
const { cloudStorage } = await import('../batch-mockup/adapters/cloud-files.mjs');
let checks = 0; const pass = s => { checks++; console.log('PASS', s); };
try {
  await database.initialise(); await database.start(); await migrateCatalog();
  const add = (kind, caseId) => db().query("INSERT INTO batch_queue(id,workspace,kind,payload,created_at) VALUES($1,'main',$2,$3,clock_timestamp())", [randomUUID(), kind, { caseId }]);
  await add('production', 'D08'); await add('production', 'D08'); await add('mockup', 'D08'); await add('analysis', 'D09');
  const first = await claimNextTask('w1', 'main'), second = await claimNextTask('w1', 'main');
  assert.deepEqual([first.kind, first.payload.caseId, second.kind, second.payload.caseId], ['production', 'D08', 'production', 'D08']);
  pass('同一条需求的两份图稿可以同时生成');
  const third = await claimNextTask('w1', 'main');
  assert.deepEqual([third.kind, third.payload.caseId], ['mockup', 'D08']);
  pass('上衣合成不必等同一条需求的其他图稿做完');
  await add('mockup', 'D08');
  const fourth = await claimNextTask('w1', 'main');
  assert.deepEqual([fourth.kind, fourth.payload.caseId], ['analysis', 'D09']);
  assert.equal(await claimNextTask('w1', 'main'), null);
  pass('同一条需求的两次上衣合成仍然依次进行，不同需求照常领取');
  await db().query("UPDATE batch_queue SET status='finished' WHERE payload->>'caseId'='D08' AND status='running'");
  assert.equal((await claimNextTask('w1', 'main')).kind, 'mockup');
  pass('前一次合成结束后，下一次合成才领取');
  await add('analysis', 'N01'); await add('production', 'N01');
  assert.equal((await claimNextTask('w1', 'main')).kind, 'analysis');
  assert.equal(await claimNextTask('w1', 'main'), null);
  pass('理解与图稿仍不在同一条需求上重叠');
  const queued = () => db().query("SELECT count(*)::int n FROM batch_queue WHERE kind='mockup' AND status='queued' AND payload->>'caseId'='M1'").then(r => r.rows[0].n);
  for (let i = 0; i < 3; i++) await cloudStorage(async adapter => { adapter.enqueue({ id: randomUUID(), kind: 'mockup', payload: { caseId: 'M1' } }); }, { workspace: 'main' });
  assert.equal(await queued(), 1);
  pass('同一条需求连续三次请求合成，队列里只留一个等待中的合成');
  assert.equal(workerConcurrency(), 3); assert.equal(workerConcurrency('20'), 20);
  assert.throws(() => workerConcurrency('0')); assert.throws(() => workerConcurrency('51')); assert.throws(() => workerConcurrency('2.5'));
  pass('并发数默认 3，可配置 1–50');
  const beforePause = (await db().query('SELECT id,status,owner FROM batch_queue ORDER BY id')).rows;
  const admission = {check: () => ({paused:true,reason:'memory_pressure'}), status: () => ({paused:true,reason:'memory_pressure'})};
  const pausedWorker = await startBatchWorker({scope:'main',admission});
  try {
    await new Promise(resolve => setTimeout(resolve,100));
    assert.equal(pausedWorker.status().ready,true);
    assert.equal(pausedWorker.status().running,0);
    assert.equal(pausedWorker.status().admission.reason,'memory_pressure');
    assert.deepEqual((await db().query('SELECT id,status,owner FROM batch_queue ORDER BY id')).rows,beforePause);
    pass('内存保护暂停领单，保留已有任务状态，心跳保持健康');
  } finally {await pausedWorker.close();}
  console.log(`批量领单集成测试通过：${checks} 组`);
} finally { await closeCatalogDatabase().catch(() => {}); await database.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); }
