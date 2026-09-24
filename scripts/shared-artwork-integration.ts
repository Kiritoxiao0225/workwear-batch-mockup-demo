import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { catalogDatabase, catalogTransaction, migrateCatalog, closeCatalogDatabase } from '../lib/server/catalog-database';
import { createCatalogUser } from '../lib/server/catalog-auth';
import { writeCloudProductionState } from '../lib/server/production-cloud-state';
import { saveProductionFile, readProductionFile } from '../lib/server/production-storage';
import { readWpsProductionState } from '../lib/server/wps-production-store';
import { emptyWpsProductionState, importTaskReviews } from '../lib/wps-production';
import { taskReviewFixture } from '../lib/testing/task-review-fixture';
import { bindingFromCatalog } from '../lib/production-garment';
import { emptyStandard, requiredLandmarks, type CatalogUser } from '../lib/catalog';
import { importCatalogAsset } from '../lib/server/catalog-import';
import { catalogDetail, savePlacementStandard } from '../lib/server/catalog-repository';
import { withGarmentBodyScale } from '../lib/server/wps-garment-sizing';
import { productionActionSnapshot, productionArtworkSnapshot, productionSharedSnapshot } from '../lib/production-artwork-snapshot';
import { sharedArtworkGroups } from '../lib/shared-artwork';
import { reconcileAutomaticSharedArtworks } from '../lib/server/automatic-shared-artwork';
import { POST as postJobs } from '../app/api/wps-production/jobs/route';
import { POST as postProduction } from '../lib/server/wps-production-actions';
import { claimArtworkJob, heartbeatArtworkWorker, readArtworkJobs } from '../lib/server/artwork-job-store';
import { processArtworkJob } from '../lib/server/artwork-job-worker';
import { renderServerArtwork } from '../lib/server/render-artwork';

// Every database and object file used here is disposable. Never load .env.local.
const root = await mkdtemp(path.join(tmpdir(), 'shared-artwork-test-'));
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
const password = randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL = `postgresql://shared_test:${password}@127.0.0.1:${port}/postgres`;
process.env.CATALOG_LOCAL_OBJECT_ROOT = path.join(root, 'objects');
process.env.WPS_PRODUCTION_STORAGE = 'cloud'; process.env.WPS_PRODUCTION_STATE_KEY = 'shared-integration'; process.env.ARTWORK_DURABLE_JOBS = '1';
process.env.CATALOG_AUTH_MODE = 'open'; process.env.CATALOG_LOGIN_EMAIL = 'shared-api@test.example'; process.env.CATALOG_APP_ORIGIN = 'http://localhost';
delete process.env.VERCEL;
const db = new EmbeddedPostgres({ databaseDir: path.join(root, 'postgres'), user: 'shared_test', password, port,
  persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: message => console.error(message) });
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External calls are forbidden in shared artwork integration'); };
const request = (route: string, body: unknown) => new NextRequest(`http://localhost/api/wps-production${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body),
});
const checks: string[] = [];
const pass = (message: string) => { checks.push(message); console.log(`PASS ${message}`); };
try {
  await db.initialise(); await db.start(); await migrateCatalog();
  const actor: CatalogUser = { id: await createCatalogUser('shared-api@test.example', 'Shared artwork integration', password, 'editor'), email: 'shared-api@test.example', displayName: 'Shared integration', role: 'editor' };
  const owner = randomUUID(); await heartbeatArtworkWorker(owner);
  const garments: Awaited<ReturnType<typeof withGarmentBodyScale>>[] = [];
  for (let index = 0; index < 9; index++) {
    const bytes = await sharp({ create: { width: 1000, height: 500, channels: 4, background: index % 2 ? '#f9f9f9' : '#111111' } }).png().toBuffer();
    const asset = await importCatalogAsset({ namespace: 'shared-test', styleCode: 'B01SD', colorName: `颜色${index + 1}`, layout: 'front_back', bytes, filename: `garment-${index}.png`, provenance: {}, sources: [] });
    const detail = await catalogDetail(asset.variantId, undefined, '00000000-0000-0000-0000-000000000001');
    for (const view of detail.views) {
      const specification = emptyStandard(); specification.structureType = 'polo';
      specification.landmarks = requiredLandmarks('polo').map((point, i) => ({ ...point, point: { x: point.key === 'leftArmpit' ? .225 : point.key === 'rightArmpit' ? .775 : .5, y: .1 + i * .1 } }));
      specification.positions = [{ key: view.face === 'back' ? 'backCenter' : 'leftChest', anchor: { x: .5, y: .5 }, printableArea: { x: .1, y: .1, width: .8, height: .8 }, defaultSize: { width: .2, height: .2 } }];
      await savePlacementStandard({ viewId: view.id, assetVersionId: detail.assetVersionId, expectedRevision: view.revision, confirm: true, specification }, actor, '00000000-0000-0000-0000-000000000001');
    }
    garments.push(await withGarmentBodyScale(bindingFromCatalog(await catalogDetail(asset.variantId, undefined, '00000000-0000-0000-0000-000000000001'), { selection: 'exact', colorText: `颜色${index + 1}`, evidence: 'isolated integration' })));
  }
  const review = taskReviewFixture()[0];
  review.source.requirementText = '九色同版，后背排字：Sales ELT\nLearn.Lead.Grow';
  review.source.materials = [];
  review.units = Array.from({ length: 9 }, (_, index) => ({ ...structuredClone(review.units[0]), id: `shared-api-${index + 1}`,
    garmentLabel: `B01SD-颜色${index + 1}`, garment: garments[index],
    logo: { materialId: null, url: null, name: '' }, placement: 'back', textMode: 'replace', exactText: 'Sales ELT\nLearn.Lead.Grow',
    instruction: '后背排字：Sales ELT\nLearn.Lead.Grow', sharedArtworkId: index < 8 ? `${review.source.recordId}:artwork:a1` : undefined }));
  review.source.wpsSource = { ...review.source.wpsSource!, status: '设计中' };
  const legacy = importTaskReviews(emptyWpsProductionState(), [review]);
  legacy.sharedArtworks = [];
  legacy.units = legacy.units.map((unit, index) => ({ ...unit, sharedArtworkId: undefined, sharedArtworkVersion: undefined, sharedArtworkDetached: index === 8 }));
  await catalogTransaction(client => writeCloudProductionState(client, legacy));
  const initial = await reconcileAutomaticSharedArtworks([review.source]);
  assert.equal(initial.revision, legacy.revision + 1);
  assert.equal(initial.sharedArtworks?.length, 1);
  assert.equal(initial.sharedArtworks[0].automatic, true);
  assert.equal(initial.sharedArtworks[0].unitIds.length, 8);
  assert.equal(initial.units[8].sharedArtworkId, undefined);
  assert.deepEqual(initial.mockupVersions, legacy.mockupVersions);
  assert.equal((await reconcileAutomaticSharedArtworks([review.source])).revision, initial.revision);
  pass('Discovery automatically persists eight untouched legacy applications once and preserves the detached ninth garment');
  const submissions = await Promise.all(initial.units.slice(0, 8).map(unit => postJobs(request('/jobs', { action: 'enqueue', units: [{ unitId: unit.id,
    snapshot: productionArtworkSnapshot(unit, initial.records[0].source), sharedSnapshot: productionSharedSnapshot(initial, unit.id) }] })).then(async response => { const body = await response.json(); assert.equal(response.status, 202, JSON.stringify(body)); return body; })));
  assert.equal(new Set(submissions.map(body => body.results[0].id)).size, 1);
  assert.ok(submissions.every(body => body.results[0].id && !body.results[0].error));
  assert.equal((await readArtworkJobs()).jobs.length, 1);
  pass('Eight concurrent real API requests for different applications enqueue exactly one shared job');
  const memberChange = { action: 'linkSharedArtwork', unitId: initial.units[0].id, targetUnitIds: [initial.units[8].id] };
  const locked = await postProduction(request('', { ...memberChange, expectedRevision: initial.revision, ...productionActionSnapshot(initial, memberChange) }));
  assert.equal(locked.status, 422);
  pass('A queued shared job blocks membership changes before paid work');
  const job = (await claimArtworkJob(owner))!;
  await processArtworkJob(job);
  let state = await readWpsProductionState();
  assert.equal((await readArtworkJobs()).jobs[0].status, 'completed', (await readArtworkJobs()).jobs[0].error ?? '');
  assert.ok(state.units.slice(0, 8).every(unit => unit.sharedArtworkVersion === 1 && unit.artwork));
  assert.equal(state.units.reduce((sum, unit) => sum + unit.attempts.length, 0), 1);
  assert.equal(new Set(state.units.slice(0, 8).map(unit => unit.artwork!.url)).size, 2);
  assert.deepEqual(state.units.map(unit => [unit.placement?.key, unit.placement?.offsetX, unit.placement?.rotation]), initial.units.map(unit => [unit.placement?.key, unit.placement?.offsetX, unit.placement?.rotation]));
  const rasterColors = await Promise.all(state.units.slice(0, 2).map(async unit => {
    const { data, info } = await sharp(await readProductionFile(unit.artwork!.url)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let value = -1; for (let offset = 0; offset < data.length; offset += info.channels) if (data[offset + 3] > 240) { value = data[offset]; break; }
    return value;
  }));
  assert.deepEqual(rasterColors, [255, 0]);
  pass('Real server rendering produces light/dark text PNGs, reuses identical variants, preserves placement and accounts for one run');
  const revision = state.revision;
  await catalogDatabase().query("UPDATE artwork_jobs SET status='queued',owner=NULL WHERE id=$1", [job.id]);
  await processArtworkJob((await claimArtworkJob(owner))!);
  assert.equal((await readWpsProductionState()).revision, revision);
  pass('Worker replay after commit is idempotent for all eight applications');
  const action = async (body: Record<string, unknown>) => {
    const latest = await readWpsProductionState();
    const response = await postProduction(request('', { ...body, expectedRevision: latest.revision, ...productionActionSnapshot(latest, body) }));
    const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json;
  };
  state = await action(memberChange);
  assert.equal(state.units[8].sharedArtworkVersion, 1);
  assert.equal(sharedArtworkGroups(state)[0].versions.length, 1);
  assert.equal(state.units.reduce((sum, unit) => sum + unit.attempts.length, 0), 1);
  pass('Appending a ninth garment applies the existing version with no generation or extra version');
  const edit = { action: 'saveArtworkDraft', unitId: state.units[0].id };
  const stale = { ...edit, expectedRevision: state.revision, ...productionActionSnapshot(state, edit) };
  const draft = structuredClone(state.units[0].artwork!.draft!); draft.text!.color = '#d52a2a';
  const rendered = await renderServerArtwork(draft); const file = await saveProductionFile(rendered.bytes, 'edited-shared.png');
  const payload = { ...edit, url: file.url, name: 'edited-shared.png', draft, service: 'manual-upload', requestSummary: '人工统一改红字', actualCostCny: 0 };
  state = await action(payload);
  assert.equal(sharedArtworkGroups(state)[0].versions.length, 2);
  assert.ok(state.units.every(unit => unit.sharedArtworkVersion === 2 && unit.artwork!.url === file.url));
  const staleResponse = await postProduction(request('', { ...payload, ...stale }));
  assert.equal(staleResponse.status, 409);
  pass('One real editor save updates all nine applications; a stale editor receives 409 without overwriting it');
  state = await action({ action: 'branchSharedArtwork', unitId: state.units[8].id });
  const branch = sharedArtworkGroups(state).find(group => group.unitIds.includes(state.units[8].id))!;
  assert.ok(branch.derivedFrom);
  state = await action({ action: 'detachSharedArtwork', unitId: state.units[7].id });
  assert.equal(state.units[7].sharedArtworkId, undefined);
  assert.equal(state.units[7].sharedArtworkDetached, true);
  assert.equal(state.units[7].artwork!.url, file.url);
  const refs = await catalogDatabase().query("SELECT count(*) AS count FROM production_file_refs WHERE state_key=$1 AND ref_key LIKE '/sharedArtworks/%'", ['shared-integration']);
  assert.ok(Number(refs.rows[0].count) >= 3);
  pass('Branch/detach preserve current artwork, and historical shared files stay protected by database references');
  console.log(JSON.stringify({ checks, paidCalls: 0, isolated: true }, null, 2));
} finally { globalThis.fetch = previousFetch; await closeCatalogDatabase(); await db.stop(); await rm(root, { recursive: true, force: true }); }
