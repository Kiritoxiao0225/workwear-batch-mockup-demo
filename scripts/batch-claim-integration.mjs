// Queue claim rules against a real PostgreSQL: one requirement's artworks may generate side by
// side, anything else on that requirement waits, and a worker never exceeds its concurrency.
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
const { claimNextTask, workerConcurrency } = await import('../batch-mockup/runtime/worker.mjs');
let checks = 0; const pass = s => { checks++; console.log('PASS', s); };
try {
  await database.initialise(); await database.start(); await migrateCatalog();
  const add = (kind, caseId) => db().query("INSERT INTO batch_queue(id,workspace,kind,payload,created_at) VALUES($1,'main',$2,$3,clock_timestamp())", [randomUUID(), kind, { caseId }]);
  await add('production', 'D08'); await add('production', 'D08'); await add('mockup', 'D08'); await add('analysis', 'D09');
  const first = await claimNextTask('w1', 'main'), second = await claimNextTask('w1', 'main');
  assert.deepEqual([first.kind, first.payload.caseId, second.kind, second.payload.caseId], ['production', 'D08', 'production', 'D08']);
  pass('同一条需求的两份图稿可以同时生成');
  const third = await claimNextTask('w1', 'main');
  assert.deepEqual([third.kind, third.payload.caseId], ['analysis', 'D09']);
  assert.equal(await claimNextTask('w1', 'main'), null);
  pass('同一条需求的上衣合成要等图稿做完，不同需求照常领取');
  await db().query("UPDATE batch_queue SET status='finished' WHERE payload->>'caseId'='D08' AND kind='production'");
  assert.equal((await claimNextTask('w1', 'main')).kind, 'mockup');
  pass('图稿做完后上衣合成才领取');
  await add('analysis', 'N01'); await add('production', 'N01');
  assert.equal((await claimNextTask('w1', 'main')).kind, 'analysis');
  assert.equal(await claimNextTask('w1', 'main'), null);
  pass('理解与图稿仍不在同一条需求上重叠');
  assert.equal(workerConcurrency(), 3); assert.equal(workerConcurrency('20'), 20);
  assert.throws(() => workerConcurrency('0')); assert.throws(() => workerConcurrency('51')); assert.throws(() => workerConcurrency('2.5'));
  pass('并发数默认 3，可配置 1–50');
  console.log(`批量领单集成测试通过：${checks} 组`);
} finally { await closeCatalogDatabase().catch(() => {}); await database.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); }
