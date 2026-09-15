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
import { inArtworkJob, artworkJobStep, withArtworkStage, resumeArtworkGenerationPrompt, resumeArtworkGenerationInput, reportArtworkInspectionRetry } from '../lib/server/artwork-job-runtime';
import { retryArtworkInspection } from '../lib/server/artwork-inspection-retry';
import { durableArtworkServices } from '../lib/server/artwork-job-services';
import { standardArtworkServices } from '../lib/server/artwork-standard-pipeline';
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
  const correction = { baseRunId: randomUUID(), url: file.url, issues: [{ id: 'check-0', location: '文字', actual: '深蓝色', expected: '白色', action: '恢复白色', preserve: '保留图形', uncertain: false }] };
  await assert.rejects(() => enqueueArtworkJob({ ...input, correction }, snapshot), /已有后台任务/);
  const correctionInput = { ...input, unit: { ...input.unit, id: 'correction-fixture' }, correction };
  const corrected = await enqueueArtworkJob(correctionInput, 'correction-snapshot');
  const correcting = (await claimArtworkJob(owner))!;
  assert.equal(correcting.id, corrected.id);
  await updateArtworkJob(correcting, 'completed', 'fixture correction saved');
  assert.deepEqual(await enqueueArtworkJob(correctionInput, 'correction-snapshot'), { id: corrected.id, existing: true });
  pass('A correction never replaces an in-flight normal job and repeat submission reuses its saved correction receipt');


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

  const legacyInput = { ...input, unit: { ...input.unit, id: 'legacy-inspection-retry' } };
  await enqueueArtworkJob(legacyInput, 'legacy-fixture');
  const legacyJob = (await claimArtworkJob(owner))!;
  const legacyRun = randomUUID(), oldPrompt = '原设计重建：旧提示词', newPrompt = '原设计重建：统一金黄色的新提示词';
  const images = ['data:image/png;base64,fixture'], settings = { background: 'auto' as const };
  let legacyGenerations = 0;
  await inArtworkJob(legacyJob, async () => {
    await artworkJobStep('generate', 'generation', [oldPrompt, images, settings], async () => { legacyGenerations++; return { bytes, model: 'fixture' }; });
    await assert.rejects(() => artworkJobStep('verifyEdits', 'inspection', bytes, async () => { throw new Error('fetch failed'); }));
  });
  await catalogDatabase().query("INSERT INTO artwork_run_records(state_key,run_id,kind,record_json) VALUES($1,$2,'generation',$3)", [legacyJob.state_key, legacyRun, { prompt: oldPrompt }]);
  await updateArtworkJob(legacyJob, 'failed', '核对失败', '旧版笼统错误', { runId: legacyRun, stage: 'edit-review', url: file.url });
  const failedView = (await readArtworkJobs()).jobs.find(item => item.id === legacyJob.id)!;
  assert.match(failedView.error!, /网络请求失败/);
  assert.match(failedView.steps.find(step => step.stage === 'inspection')!.error!, /网络请求失败/);
  await changeArtworkJob(legacyJob.id, 'retry');
  const legacyResumed = (await claimArtworkJob(owner2))!;
  let inspectionRequests = 0;
  await inArtworkJob(legacyResumed, async () => {
    const prompt = await resumeArtworkGenerationPrompt(newPrompt, images, settings);
    assert.equal(prompt, oldPrompt);
    const result = await artworkJobStep('generate', 'generation', [prompt, images, settings], async () => { legacyGenerations++; return { bytes, model: 'fixture' }; });
    assert.deepEqual(result.bytes, bytes);
    const inspected = await artworkJobStep('verifyEdits', 'inspection', bytes, () => retryArtworkInspection(async () => {
      inspectionRequests++;
      if (inspectionRequests === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return { status: 'passed' };
    }, { onRetry: async notice => {
      await reportArtworkInspectionRetry(notice);
      const during = (await readArtworkJobs()).jobs.find(item => item.id === legacyJob.id)!;
      assert.equal(during.status, 'running');
      assert.equal(during.steps.find(step => step.stage === 'inspection')!.status, 'running');
      assert.match(during.message, /自动恢复（第 2\/3 次）/);
      assert.equal(legacyGenerations, 1);
    } }));
    assert.deepEqual(inspected, { value: { status: 'passed' }, attempts: 2 });
    assert.deepEqual(await artworkJobStep('verifyEdits', 'inspection', bytes, async () => { throw new Error('completed inspection must be reused'); }), inspected);
    const originalVerify = standardArtworkServices.verifyEdits;
    let upgradedChecks = 0;
    try {
      const requirements = ['保留文字与标志'];
      await artworkJobStep('verifyEdits', 'inspection', [bytes, bytes, requirements], async () => ({ version: 'old-check', checks: [] }));
      standardArtworkServices.verifyEdits = async (source, output, checks) => {
        assert.deepEqual(source, bytes); assert.deepEqual(output, bytes);
        upgradedChecks++;
        return { version: 'artwork-edit-check-v1', sourceSha256: 'fixture-source', outputSha256: 'fixture-output', model: 'fixture',
          inspectionVersion: 'artwork-edit-inspection-v2', checks: checks.map(requirement => ({ requirement, status: 'passed', evidence: '文字与标志保持原样' })) };
      };
      const current = await durableArtworkServices().verifyEdits(bytes, bytes, requirements);
      assert.equal(current.inspectionVersion, 'artwork-edit-inspection-v2');
      assert.deepEqual(await durableArtworkServices().verifyEdits(bytes, bytes, requirements), current);
      assert.equal(upgradedChecks, 1);
      assert.equal(legacyGenerations, 1);
    } finally { standardArtworkServices.verifyEdits = originalVerify; }
    await assert.rejects(() => resumeArtworkGenerationPrompt(newPrompt, ['different input'], settings), /停止重复生图/);
    const cropResume = await resumeArtworkGenerationInput(newPrompt, ['new target crop'], settings, images);
    assert.equal(cropResume.prompt, oldPrompt); assert.equal(cropResume.reusedOriginalInput, true);
    await assert.rejects(() => resumeArtworkGenerationInput(newPrompt, ['new target crop'], settings, ['unrelated original']), /停止重复生图/);
  });
  await assert.rejects(() => inArtworkJob({ ...legacyResumed, owner }, () => reportArtworkInspectionRetry({ attempt: 3, maxAttempts: 3, delayMs: 5000 })));
  assert.equal(inspectionRequests, 2);
  assert.equal(legacyGenerations, 1);
  await updateArtworkJob(legacyResumed, 'completed', 'fixture done');
  pass('A legacy inspection retry exposes its real error and reuses the original generation across prompt upgrades; mismatched inputs cannot regenerate');
  pass('A transient inspection failure stays running, reports automatic recovery, saves and reuses its final check; stale owners cannot retry');
  pass('Upgraded inspection ignores a legacy check, caches the current version and never regenerates the image');

  await enqueueArtworkJob({ ...input, unit: { ...input.unit, id: 'unknown-enhancement' } }, 'enhancement-fixture');
  const enhancing = (await claimArtworkJob(owner))!;
  let enhancementCalls = 0;
  const enhance = () => artworkJobStep('mediakit:/api/v1/tools-sync/enhance-image', 'processing', { image: 'fixture' }, async () => { enhancementCalls++; throw new Error('fetch failed'); }, true, true);
  await assert.rejects(() => inArtworkJob(enhancing, enhance), /结果尚不确定/);
  await assert.rejects(() => inArtworkJob(enhancing, enhance), /停止重复提交/);
  assert.equal(enhancementCalls, 1);
  await catalogDatabase().query("UPDATE artwork_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [enhancing.id]);
  assert.equal(await claimArtworkJob(owner2), null);
  assert.equal((await readArtworkJobs()).jobs.find(item => item.id === enhancing.id)?.status, 'unknown');
  await assert.rejects(() => changeArtworkJob(enhancing.id, 'retry'));
  pass('Lost paid enhancement is fenced across retries and worker takeover without a second provider submission');

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
  const finalReview = saved.units[0].artwork?.validation.review;
  assert.equal(finalReview?.sha256, saved.units[0].artwork?.validation.sha256);
  assert.equal(finalReview?.items.find(item => item.id === 'text')?.status, 'uncertain');
  assert.equal(finalReview?.items.find(item => item.id === 'position')?.status, 'pending');
  const revision = saved.revision;
  // Simulate death after production commit but before the job-completed update.
  await catalogDatabase().query("UPDATE artwork_jobs SET status='queued',owner=NULL WHERE id=$1", [textJob.id]);
  const afterSave = (await claimArtworkJob(owner2))!; await processArtworkJob(afterSave);
  assert.equal((await readWpsProductionState()).revision, revision);
  assert.deepEqual((await readWpsProductionState()).units[0].artwork?.validation.review, finalReview);
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
  // It must now process only the new queue and autonomously attempt WPS sync.
  // WPS/network is denied in this isolated test; legacy jobs must stay untouched.
  const batchWorkspace = 'standalone-test';
  await catalogDatabase().query('INSERT INTO batch_documents(workspace,path,content_json) VALUES($1,$2,$3)', [batchWorkspace, 'manifest.json', { run: {}, cases: [] }]);
  const batchJob = randomUUID();
  await catalogDatabase().query("INSERT INTO batch_queue(id,workspace,kind,payload) VALUES($1,$2,'mockup',$3)", [batchJob, batchWorkspace, { caseId: 'no-active-case' }]);
  const denyNetwork = path.join(root, 'deny-network.mjs');
  await writeFile(denyNetwork, 'globalThis.fetch = async () => { throw new Error("Worker integration forbids network requests"); };');
  const child = spawn(process.execPath, ['--import', denyNetwork, '--import', 'tsx', 'scripts/artwork-worker.ts'], { env: { ...process.env, BATCH_WORKBENCH_ENABLED: '1', BATCH_WORKSPACE: batchWorkspace, VERCEL: '', CATALOG_DATABASE_CA_CERT: '', PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  const childExit = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    const deadline = Date.now() + 30_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      status = (await catalogDatabase().query('SELECT status FROM batch_queue WHERE id=$1', [batchJob])).rows[0]?.status;
      const sync = await catalogDatabase().query("SELECT 1 FROM batch_queue WHERE workspace=$1 AND kind='sync' AND payload->>'automatic'='true' AND status='failed'", [batchWorkspace]);
      if ((status === 'finished' && sync.rowCount) || child.exitCode !== null) break;
      await delay(200);
    }
    assert.equal(status, 'finished', logs);
    assert.ok(logs.includes('[batch-worker] ready'));
    assert.equal((await readArtworkJobs()).jobs.find(job => job.id === batch.results[1].id)?.status, 'queued');
    assert.equal((await catalogDatabase().query("SELECT count(*)::int n FROM batch_queue WHERE workspace=$1 AND kind='sync' AND payload->>'automatic'='true' AND status='failed'", [batchWorkspace])).rows[0].n, 1);
  } finally { child.kill('SIGTERM'); }
  assert.equal(await childExit, 0, logs);
  pass('Standalone new worker processes its queue and schedules WPS without a browser, leaves legacy jobs untouched and drains on SIGTERM');
  console.log(JSON.stringify({ checks, generatedCalls: generated, scoringCalls: scored, peak, paidCalls: 0 }, null, 2));
} finally {
  globalThis.fetch = savedFetch; await closeCatalogDatabase(); await db.stop(); await rm(root, { recursive: true, force: true });
}
