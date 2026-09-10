import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { NextRequest } from 'next/server';
import { createCatalogUser } from '../lib/server/catalog-auth';
import { POST as postJobs } from '../app/api/wps-production/jobs/route';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction, migrateCatalog, closeCatalogDatabase } from '../lib/server/catalog-database';
import { enqueueArtworkJob, claimArtworkJob, readArtworkJobs, changeArtworkJob, heartbeatArtworkWorker, updateArtworkJob, type ArtworkJob } from '../lib/server/artwork-job-store';
import { inArtworkJob, artworkJobStep, withArtworkStage } from '../lib/server/artwork-job-runtime';
import { evaluateArtworkBytes } from '../lib/server/media-kit-artwork';
import { processArtworkJob } from '../lib/server/artwork-job-worker';
import { saveProductionFile, readProductionFile } from '../lib/server/production-storage';
import { writeCloudProductionState } from '../lib/server/production-cloud-state';
import { emptyWpsProductionState, importTaskReviews } from '../lib/wps-production';
import { taskReviewFixture } from '../lib/testing/task-review-fixture';
import { productionArtworkSnapshot } from '../lib/production-artwork-snapshot';
import { readWpsProductionState } from '../lib/server/wps-production-store';
import { renderServerArtwork, serverProductionTextDraft } from '../lib/server/render-artwork';
import { cleanupReplacedFiles, queueReplacedFiles } from '../lib/server/production-replaced-files';

const root = await mkdtemp(path.join(tmpdir(), 'artwork-jobs-test-'));
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
const password = randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL = `postgresql://jobs_test:${password}@127.0.0.1:${port}/postgres`;
process.env.CATALOG_LOCAL_OBJECT_ROOT = path.join(root, 'objects');
process.env.WPS_PRODUCTION_STORAGE = 'cloud'; process.env.WPS_PRODUCTION_STATE_KEY = 'jobs-integration'; process.env.ARTWORK_DURABLE_JOBS = '1';
delete process.env.VERCEL;
const db = new EmbeddedPostgres({ databaseDir: path.join(root, 'postgres'), user: 'jobs_test', password, port,
  persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: message => console.error(message) });
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Integration must not call any real network / paid service'); };
const owner = randomUUID(), owner2 = randomUUID();
const checks: string[] = [];
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
try {
  await db.initialise(); await db.start(); await migrateCatalog(); await heartbeatArtworkWorker(owner); await heartbeatArtworkWorker(owner2);
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#24684a' } }).extend({ top: 10, bottom: 10, left: 10, right: 10, background: '#00000000' }).png().toBuffer();
  const file = await saveProductionFile(bytes, 'fixture.png');
  const fixture = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[2]]);
  fixture.records[0].source.materials.forEach(material => { material.url = file.url; material.previewUrl = file.url; });
  const input = { unit: fixture.units[0], source: fixture.records[0].source };
  const snapshot = productionArtworkSnapshot(input.unit, input.source);
  const submitted = await Promise.all(Array.from({ length: 8 }, () => enqueueArtworkJob(input, snapshot)));
  assert.equal(new Set(submitted.map(job => job.id)).size, 1);
  assert.equal(submitted.filter(job => !job.existing).length, 1);
  assert.equal((await readArtworkJobs()).workerOnline, true);
  const claimed = await Promise.all([claimArtworkJob(owner), claimArtworkJob(owner2)]);
  assert.equal(claimed.filter(Boolean).length, 1);
  const job = claimed.find(Boolean)!;
  await assert.rejects(() => changeArtworkJob(job.id, 'cancel'));
  pass('8 submissions from independent clients produce one job; two workers claim it once; running work cannot be cancelled');

  let generated = 0, scored = 0;
  await inArtworkJob(job, async () => {
    await artworkJobStep('model', 'generation', { request: 'same' }, async () => { generated++; return { bytes, model: 'fixture' }; });
    await assert.rejects(() => artworkJobStep('score', 'quality', bytes, async () => { scored++; throw new Error('RequestLimitExceeded'); }));
  });
  await updateArtworkJob(job, 'failed', 'fixture scoring failed'); await changeArtworkJob(job.id, 'retry');
  await closeCatalogDatabase();
  const resumed = (await claimArtworkJob(owner2))!;
  await inArtworkJob(resumed, async () => {
    const result = await artworkJobStep('model', 'generation', { request: 'same' }, async () => { generated++; return { bytes, model: 'fixture' }; });
    assert.deepEqual(result.bytes, bytes);
    await artworkJobStep('score', 'quality', bytes, async () => { scored++; return { score: 90 }; });
  });
  assert.equal(generated, 1); assert.equal(scored, 2);
  const blockedFetch = globalThis.fetch;
  const uploads = new Map<string, Uint8Array>(), evaluated: string[] = [];
  let tickets = 0;
  process.env.MEDIAKIT_API_KEY = 'integration-dummy-key';
  globalThis.fetch = async (target, init) => {
    const url = String(target);
    if (url.endsWith('/request-media-upload-url')) {
      const id = ++tickets;
      return Response.json({ success: true, result: { upload_url: `https://fixture.invalid/upload/${id}`, file_id: `mediakit://fixture-${id}`, upload_headers: [] } });
    }
    if (url.startsWith('https://fixture.invalid/upload/')) { uploads.set(url, init!.body as Uint8Array); return new Response(null, { status: 200 }); }
    if (url.endsWith('/evaluate-image-quality')) {
      const body = JSON.parse(String(init!.body)); evaluated.push(body.image_url);
      return Response.json({ success: true, result: { vqscore: 90, blur: 1, noise: 0, cmartifacts: 0 } });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  try {
    await inArtworkJob(resumed, async () => {
      const other = await sharp(bytes).negate().png().toBuffer();
      await Promise.all([evaluateArtworkBytes(bytes), evaluateArtworkBytes(other)]);
      await evaluateArtworkBytes(bytes);
    });
    assert.equal(tickets, 2); assert.equal(uploads.size, 2);
    assert.notDeepEqual([...uploads.values()][0], [...uploads.values()][1]);
    assert.equal(new Set(evaluated).size, 2);
  } finally { globalThis.fetch = blockedFetch; }
  pass('Distinct source/result images get distinct upload tickets; retry reuses the correct uploaded pixels');
  await updateArtworkJob(resumed, 'completed', 'fixture saved');
  pass('DB reconnect and failed-score retry restore the exact generated PNG without a second model call');

  const unknownInput = { ...input, unit: { ...input.unit, id: 'unknown-generation' } };
  await enqueueArtworkJob(unknownInput, 'unknown-fixture');
  const uncertain = (await claimArtworkJob(owner))!;
  await catalogDatabase().query("INSERT INTO artwork_job_steps(job_id,step_key,stage,status) VALUES($1,'lost-request','generation','running')", [uncertain.id]);
  await catalogDatabase().query("UPDATE artwork_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [uncertain.id]);
  assert.equal(await claimArtworkJob(owner2), null);
  assert.equal((await readArtworkJobs()).jobs.find(item => item.id === uncertain.id)?.status, 'unknown');
  await assert.rejects(() => changeArtworkJob(uncertain.id, 'retry'));
  await assert.rejects(() => inArtworkJob(uncertain, () => withArtworkStage('quality', async () => 'must not run')));
  pass('Lost paid response is marked unknown; takeover cannot regenerate; old worker is fenced');

  const jobs: ArtworkJob[] = [];
  for (let index = 0; index < 12; index++) {
    await enqueueArtworkJob({ ...input, unit: { ...input.unit, id: `batch-${index}` } }, `batch-${index}`);
    jobs.push((await claimArtworkJob(index % 2 ? owner : owner2))!);
  }
  const active = { generation: 0, cutout: 0, quality: 0 }, peak = { ...active };
  let cutoutsWhileScoring = 0, completions = 0;
  let releaseQuality!: () => void, signalQuality!: () => void;
  const qualityStarted = new Promise<void>(resolve => { signalQuality = resolve; });
  const qualityGate = new Promise<void>(resolve => { releaseQuality = resolve; });
  const qualityBlocker = inArtworkJob(jobs[0], () => withArtworkStage('quality', async () => { active.quality++; peak.quality = 1; signalQuality(); await qualityGate; active.quality--; }));
  await qualityStarted;
  await Promise.all(jobs.map((item, index) => inArtworkJob(item, async () => {
    const simulate = async (stage: keyof typeof active, ms: number) => withArtworkStage(stage, async () => {
      active[stage]++; peak[stage] = Math.max(peak[stage], active[stage]);
      if (stage === 'cutout' && active.quality) { cutoutsWhileScoring++; releaseQuality(); }
      try { await delay(ms); } finally { active[stage]--; }
    });
    await simulate('generation', 150 + index * 10);
    await simulate('cutout', 120);
    await simulate('quality', 160);
    completions++; await updateArtworkJob(item, 'completed', 'fixture done');
  })));
  await qualityBlocker;
  assert.deepEqual(peak, { generation: 6, cutout: 2, quality: 1 });
  assert.ok(cutoutsWhileScoring > 0); assert.equal(completions, 12);
  pass(`12-item batch with two workers respects 6/2/1 global caps; ${cutoutsWhileScoring} cutouts start while scoring is busy`);

  const waiting = await enqueueArtworkJob({ ...input, unit: { ...input.unit, id: 'cancelled-job' } }, 'cancel-fixture');
  await changeArtworkJob(waiting.id, 'cancel');
  assert.equal(await claimArtworkJob(owner), null);
  await catalogTransaction(client => queueReplacedFiles(client, [file.id]));
  const cleaned = await cleanupReplacedFiles();
  assert.ok(!cleaned.deleted.includes(file.id));
  assert.deepEqual(await readProductionFile(file.url), bytes);
  pass('Queued cancellation survives reconnect; job input and intermediate files remain protected from garbage collection');

  // Exercise the real renderer, production validation and CAS save with zero external API calls.
  const textUnit = { ...input.unit, id: 'server-text', materialId: null, referenceMaterialIds: [], sourceScope: 'wholeImage' as const,
    textMode: 'replace' as const, exactText: '鹏领工服 ABC 2026', instruction: '单纯文字，字色白色', layoutNote: '单纯文字', generationPrompt: '',
    route: 'deterministic' as const, artworkMethod: 'compose' as const, ambiguities: [], artwork: null };
  const textDraft = await serverProductionTextDraft(textUnit, '#ffffff');
  const render = await renderServerArtwork(textDraft);
  const metadata = await sharp(render.bytes).metadata();
  assert.equal(metadata.hasAlpha, true); assert.ok(render.contentBounds.width > 200); assert.ok(render.letters.length >= 10);
  const textSource = { ...input.source, materials: [], requirementText: '只需要白色文字：鹏领工服 ABC 2026' };
  const textState = { ...fixture, units: [textUnit], records: [{ ...fixture.records[0], source: textSource, unitIds: [textUnit.id] }], mockupVersions: [] };
  await catalogTransaction(client => writeCloudProductionState(client, textState));
  const textQueued = await enqueueArtworkJob({ unit: textUnit, source: textSource }, productionArtworkSnapshot(textUnit, textSource));
  const textJob = (await claimArtworkJob(owner))!;
  await processArtworkJob(textJob);
  const textStatus = (await readArtworkJobs()).jobs.find(item => item.id === textQueued.id)!;
  assert.equal(textStatus.status, 'completed', textStatus.error ?? textStatus.message);
  const saved = await readWpsProductionState();
  assert.ok(saved.units[0].artwork?.url);
  assert.equal(saved.units[0].artwork?.draft?.text?.value, textUnit.exactText);
  const revision = saved.revision;
  // Simulate death after production commit but before the job-completed update.
  await catalogDatabase().query("UPDATE artwork_jobs SET status='queued',owner=NULL WHERE id=$1", [textJob.id]);
  const afterSave = (await claimArtworkJob(owner2))!; await processArtworkJob(afterSave);
  assert.equal((await readWpsProductionState()).revision, revision);
  pass('Real server PNG rendering, transparent validation and CAS save work without a browser; replay after commit makes no duplicate save');

  const staleUnit = { ...textUnit, id: 'stale-task' };
  await enqueueArtworkJob({ unit: staleUnit, source: textSource }, 'stale');
  const stale = (await claimArtworkJob(owner))!; await processArtworkJob(stale);
  assert.equal((await readArtworkJobs()).jobs.find(item => item.id === stale.id)?.status, 'failed');
  assert.equal((await readWpsProductionState()).revision, revision);
  pass('Changed or removed production targets never receive a stale background result');
  await createCatalogUser('job-api@test.example', 'job API test', password, 'editor');
  process.env.CATALOG_AUTH_MODE = 'open'; process.env.CATALOG_LOGIN_EMAIL = 'job-api@test.example'; process.env.CATALOG_APP_ORIGIN = 'http://localhost';
  const api = (body: unknown, origin = 'http://localhost') => postJobs(new NextRequest('http://localhost/api/wps-production/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  }));
  assert.equal((await api({ action: 'enqueue', units: [] }, 'https://untrusted.example')).status, 403);
  assert.equal((await api({ action: 'enqueue', units: Array.from({ length: 101 }, () => ({ unitId: textUnit.id, snapshot: 'x' })) })).status, 400);
  const latestState = await readWpsProductionState();
  const httpResult = await api({ action: 'enqueue', units: [
    { unitId: 'missing', snapshot: 'stale' },
    { unitId: textUnit.id, snapshot: productionArtworkSnapshot(latestState.units[0], latestState.records[0].source) },
  ] });
  assert.equal(httpResult.status, 202);
  const batch = await httpResult.json();
  assert.ok(batch.results[0].error); assert.ok(batch.results[1].id);
  pass('Actual jobs API enforces origin, 100-item bound and per-item failure isolation');

  // Start the actual standalone executable against this isolated database.
  // No browser request drives the worker, and there are no paid-image jobs in its queue.
  const denyNetwork = path.join(root, 'deny-network.mjs');
  await writeFile(denyNetwork, 'globalThis.fetch = async () => { throw new Error("Worker integration forbids network requests"); };');
  const child = spawn(process.execPath, ['--import', denyNetwork, '--import', 'tsx', 'scripts/artwork-worker.ts'], { env: { ...process.env, VERCEL: '', CATALOG_DATABASE_CA_CERT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  const childExit = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    const deadline = Date.now() + 30_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      status = (await readArtworkJobs()).jobs.find(job => job.id === batch.results[1].id)?.status;
      if (status === 'completed' || status === 'failed' || child.exitCode !== null) break;
      await delay(200);
    }
    assert.equal(status, 'completed', logs);
    assert.ok(logs.includes('[artwork-worker] ready'));
  } finally { child.kill('SIGTERM'); }
  assert.equal(await childExit, 0, logs);
  pass('Standalone worker command loads, processes a queued job without a browser and drains cleanly on SIGTERM');
  console.log(JSON.stringify({ checks, generatedCalls: generated, scoringCalls: scored, peak, paidCalls: 0 }, null, 2));
} finally {
  globalThis.fetch = savedFetch; await closeCatalogDatabase(); await db.stop(); await rm(root, { recursive: true, force: true });
}
