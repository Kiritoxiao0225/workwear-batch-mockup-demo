import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction, closeCatalogDatabase, migrateCatalog } from '../lib/server/catalog-database';
import { backupCatalog, restoreCatalog } from '../lib/server/catalog-backup';
import { writeCloudProductionState } from '../lib/server/production-cloud-state';
import { emptyWpsProductionState } from '../lib/wps-production';
import { taskReviewFixture } from '../lib/testing/task-review-fixture';
import { mutateWpsProductionState, readWpsProductionState } from '../lib/server/wps-production-store';
import { saveProductionFile, readProductionFile } from '../lib/server/production-storage';
import { fileSha256 } from '../lib/server/catalog-files';
import { claimCutoutJob, readCutoutJob, saveCutoutJob, migrateCutoutImages, type StoredCutout } from '../lib/server/artwork-cutout-store';
import { cleanupReplacedFiles, queueReplacedFiles } from '../lib/server/production-replaced-files';
import { claimWpsAnalysis, enqueueWpsAnalysis, heartbeatWpsAnalysis, readWpsAnalysisJobs } from '../lib/server/wps-analysis-jobs';
import { processWpsAnalysis } from '../lib/server/wps-analysis-worker';
import { productionThumbnail } from '../lib/server/production-thumbnail';
import type { TaskReview, SourceTaskRecord } from '../lib/batch-task-review';

// A disposable real database + filesystem; all WPS and model services are fakes.
const root = await mkdtemp(path.join(tmpdir(), 'production-reliability-'));
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
const password = randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL = `postgresql://reliability_test:${password}@127.0.0.1:${port}/postgres`;
process.env.CATALOG_LOCAL_OBJECT_ROOT = path.join(root, 'objects');
process.env.WPS_PRODUCTION_STORAGE = 'cloud'; process.env.WPS_PRODUCTION_STATE_KEY = 'reliability';
process.env.ARTWORK_CUTOUT_FILE_STORAGE = 'oss';
process.env.WPS_DURABLE_ANALYSIS = '1'; process.env.ARTWORK_DURABLE_JOBS = '1';
delete process.env.VERCEL; delete process.env.CATALOG_DATABASE_CA_CERT;
const db = new EmbeddedPostgres({ databaseDir: path.join(root, 'postgres'), user: 'reliability_test', password, port,
  persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: message => console.error(message) });
const oldFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('External calls forbidden'); };
const pass = (name: string) => console.log(`PASS ${name}`);
try {
  await db.initialise(); await db.start(); await migrateCatalog();
  await catalogTransaction(client => writeCloudProductionState(client, emptyWpsProductionState()));
  const pixels = await sharp({ create: { width: 1200, height: 800, channels: 4, background: '#7d2933' } }).png({ compressionLevel: 0 }).toBuffer();
  const file = await saveProductionFile(pixels, 'source.png');
  const thumb = await productionThumbnail(file.id, file.sha256);
  assert.ok(thumb.length < pixels.length / 10); assert.equal((await sharp(thumb).metadata()).width, 320);
  assert.deepEqual(await readProductionFile(file.url), pixels);
  pass('320px thumbnail is smaller; source bytes and SHA remain identical');

  const inline = `data:image/png;base64,${pixels.toString('base64')}`;
  const key = fileSha256('cutout-receipt-fixture');
  const receipt: StoredCutout = { requestId: randomUUID(), updatedAt: new Date().toISOString(), phase: 'submitted', status: 'pending',
    receipt: { jobKey: key, route: 'volcano', mode: 'auto', reasons: [], version: 'artwork-cutout-v4', estimatedCredits: null,
      actualCredits: null, sourceSha256: file.sha256, sourceUrl: inline, taskId: 'existing-paid-task', cacheHit: false } };
  const claims = await Promise.all([claimCutoutJob(receipt), claimCutoutJob(receipt)]); assert.equal(claims.filter(Boolean).length, 1);
  const storedSize = (await catalogDatabase().query('SELECT pg_column_size(job_json) AS size FROM artwork_cutout_jobs WHERE job_key=$1', [key])).rows[0].size;
  assert.ok(storedSize < 2000);
  await closeCatalogDatabase();
  assert.deepEqual(await readCutoutJob(key), receipt);
  await saveCutoutJob({ ...receipt, phase: 'finished', status: 'completed', url: inline });
  assert.equal((await readCutoutJob(key))!.url, inline);
  await catalogTransaction(client => queueReplacedFiles(client, [file.id]));
  await cleanupReplacedFiles(); assert.deepEqual(await readProductionFile(file.url), pixels);
  const legacyKey = fileSha256('legacy');
  const legacy = { ...receipt, receipt: { ...receipt.receipt, jobKey: legacyKey } };
  await catalogDatabase().query('INSERT INTO artwork_cutout_jobs(state_key,job_key,job_json) VALUES($1,$2,$3)', ['reliability', legacyKey, legacy]);
  assert.deepEqual(await readCutoutJob(legacyKey), legacy);
  assert.deepEqual(await migrateCutoutImages(), { scanned: 1, migrated: 1 });
  assert.deepEqual(await readCutoutJob(legacyKey), legacy);
  pass('pending/finished/legacy cutout round-trip, same provider task, exact bytes, small JSON and GC protection');

  const makeReview = (id: string): TaskReview => {
    const review = structuredClone(taskReviewFixture()[0]);
    review.source.recordId = id;
    review.source.materials = review.source.materials.map(material => ({ ...material, url: file.url, previewUrl: file.url }));
    review.source.wpsSource = { fileId: 'fixture', sheetId: 1, sheetName: 'fixture', statusFieldName: 'status', status: '待领取', statusOptions: [] };
    review.units = review.units.map((unit, i) => ({ ...unit, id: `${id}-unit-${i}`, sharedArtworkId: `${id}-shared` }));
    return review;
  };
  const owner = randomUUID(); await heartbeatWpsAnalysis(owner);
  const reviews = Array.from({ length: 6 }, (_, i) => makeReview(`cap-${i}`));
  const duplicate = await Promise.all(Array.from({ length: 8 }, () => enqueueWpsAnalysis(reviews[0].source)));
  assert.equal(new Set(duplicate.map(job => job.id)).size, 1);
  for (const review of reviews.slice(1)) await enqueueWpsAnalysis(review.source);
  const claimed = await Promise.all(Array.from({ length: 8 }, () => claimWpsAnalysis(owner)));
  assert.equal(claimed.filter(Boolean).length, 5);
  const first = claimed.find(Boolean)!;
  await catalogDatabase().query("UPDATE wps_analysis_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
  const next = await claimWpsAnalysis(owner); assert.ok(next); assert.notEqual(next.id, first.id);
  assert.equal((await catalogDatabase().query('SELECT status FROM wps_analysis_jobs WHERE id=$1', [first.id])).rows[0].status, 'unknown');
  await catalogDatabase().query("UPDATE wps_analysis_jobs SET status='failed',owner=NULL,lease_until=NULL");
  pass('eight browser submissions deduplicate; global five-job cap; expired model submissions become unknown');

  let modelCalls = 0, verifyCalls = 0, saveFailure = false;
  let live: SourceTaskRecord;
  let resultReview: TaskReview;
  type Services = NonNullable<Parameters<typeof processWpsAnalysis>[1]>;
  let modelGate: Promise<void> = Promise.resolve();
  let started = () => {};
  const services: Services = {
    verify: async sources => { verifyCalls++; assert.deepEqual(sources.map(source => source.requirementText), [live.requirementText]); if (saveFailure && verifyCalls === 2) throw new Error('temporary WPS network failure'); },
    sources: async () => ({ records: [live] }) as Awaited<ReturnType<Services['sources']>>,
    analyze: async () => { modelCalls++; started(); await modelGate; return { reviews: [resultReview], model: 'fixture-no-paid-calls' } as Awaited<ReturnType<Services['analyze']>>; },
    previews: async () => {},
  };
  const run = async (review: TaskReview) => {
    resultReview = review; live = review.source; verifyCalls = 0;
    const queued = await enqueueWpsAnalysis(review.source); const job = await claimWpsAnalysis(owner); assert.equal(job?.id, queued.id);
    await processWpsAnalysis(job!, services); return job!;
  };
  const review = makeReview('recover'); saveFailure = true;
  const failed = await run(review); assert.equal(modelCalls, 1);
  assert.equal((await catalogDatabase().query('SELECT status FROM wps_analysis_jobs WHERE id=$1', [failed.id])).rows[0].status, 'failed');
  await closeCatalogDatabase(); saveFailure = false;
  await enqueueWpsAnalysis(review.source, true); const recovered = await claimWpsAnalysis(owner); assert.ok(recovered?.result_json);
  await processWpsAnalysis(recovered!, services); assert.equal(modelCalls, 1);
  let state = await readWpsProductionState(); assert.ok(state.units.some(unit => unit.sourceRecordId === 'recover'));
  assert.ok(state.sharedArtworks?.some(group => group.sourceRecordId === 'recover'));
  assert.equal((await enqueueWpsAnalysis(review.source)).id, null);
  // Simulate the worker stopping immediately after the production transaction committed.
  await catalogDatabase().query("UPDATE wps_analysis_jobs SET status='saving',owner=$2,lease_until=now()-interval '1 second' WHERE id=$1", [recovered!.id, owner]);
  const receiptReplay = await claimWpsAnalysis(owner); await processWpsAnalysis(receiptReplay!, services); assert.equal(modelCalls, 1);
  assert.equal((await readWpsProductionState()).revision, state.revision);
  pass('parsed result and save receipt recover after reconnect without a second model call; shared definitions survive');

  const changed = structuredClone(review); changed.source.requirementText += ' 新要求'; live = changed.source; resultReview = changed;
  await enqueueWpsAnalysis(changed.source); const delayed = (await claimWpsAnalysis(owner))!;
  let release!: () => void; modelGate = new Promise<void>(resolve => { release = resolve; });
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const work = processWpsAnalysis(delayed, services); await modelStarted;
  state = await mutateWpsProductionState(state.revision, current => ({ ...current, revision: current.revision + 1,
    units: current.units.map(unit => unit.sourceRecordId === 'recover' ? { ...unit, routeEvidence: '人工编辑必须保留', updatedAt: new Date().toISOString() } : unit) }));
  release(); await work;
  assert.equal((await catalogDatabase().query('SELECT status FROM wps_analysis_jobs WHERE id=$1', [delayed.id])).rows[0].status, 'stale');
  assert.ok((await readWpsProductionState()).units.every(unit => unit.sourceRecordId !== 'recover' || unit.routeEvidence === '人工编辑必须保留'));
  pass('late analysis is rejected inside CAS after a manual edit; manual/shared state survives');

  const unrelated = makeReview('independent'); live = unrelated.source; resultReview = unrelated;
  await enqueueWpsAnalysis(unrelated.source); const parallel = (await claimWpsAnalysis(owner))!;
  modelGate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const pending = processWpsAnalysis(parallel, services); await began;
  await mutateWpsProductionState(state.revision, current => ({ ...current, revision: current.revision + 1, budgetLimitCny: 123 }));
  release(); await pending;
  assert.equal((await catalogDatabase().query('SELECT status FROM wps_analysis_jobs WHERE id=$1', [parallel.id])).rows[0].status, 'completed');
  assert.equal((await readWpsProductionState()).budgetLimitCny, 123);
  pass('unrelated order/global metadata changes do not block a valid parsed save');

  // Returning to an earlier WPS brief reuses its response with a fresh save ID.
  modelGate = Promise.resolve(); started = () => {};
  const original = makeReview('reverted'); const initialJob = await run(original);
  const alternative = structuredClone(original); alternative.source.requirementText += ' 修订';
  await run(alternative); const beforeRevert = modelCalls;
  const resumed = await run(original); assert.equal(modelCalls, beforeRevert);
  assert.notEqual(resumed.save_id, initialJob.save_id);
  assert.equal((await readWpsAnalysisJobs()).jobs.find(job => job.recordId === original.source.recordId)?.id, initialJob.id);
  pass('reverted source reuses parsed content with a new save receipt and remains visible as the latest task');

  const backup = await backupCatalog();
  assert.ok(backup.payload.tables.artwork_cutout_files.length); assert.ok(backup.payload.tables.wps_analysis_files.length);
  await catalogDatabase().query('CREATE DATABASE reliability_restore'); await closeCatalogDatabase();
  process.env.CATALOG_DATABASE_URL = `postgresql://reliability_test:${password}@127.0.0.1:${port}/reliability_restore`;
  await migrateCatalog(); await restoreCatalog(backup);
  assert.equal((await readCutoutJob(key))!.receipt.taskId, receipt.receipt.taskId);
  assert.equal((await catalogDatabase().query('SELECT count(*)::int AS n FROM wps_analysis_jobs')).rows[0].n, backup.payload.tables.wps_analysis_jobs.length);
  pass('fresh database restore retains cutout images, analysis results, protected file references and save receipts');
} finally {
  globalThis.fetch = oldFetch; await closeCatalogDatabase(); await db.stop(); await rm(root, { recursive: true, force: true });
}
