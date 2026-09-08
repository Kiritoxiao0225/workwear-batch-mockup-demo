import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import OSS from 'ali-oss';
const oss = () => new OSS({ region: process.env.CATALOG_OSS_REGION!, bucket: process.env.CATALOG_OSS_BUCKET!, accessKeyId: process.env.PRODUCTION_DELETE_ACCESS_KEY_ID!, accessKeySecret: process.env.PRODUCTION_DELETE_ACCESS_KEY_SECRET!, secure: true, authorizationV4: true, timeout: 5000 });
async function assertObjectDeleted(id: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const row = (await db.query('SELECT gc_state,object_key FROM files WHERE id=$1', [id])).rows[0];
    if (row.gc_state === 'deleted') {
      await assert.rejects(() => oss().head(row.object_key), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'NoSuchKey'));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail('replacement object must be physically deleted');
}
import { catalogDatabase, catalogTransaction, closeCatalogDatabase } from '../lib/server/catalog-database';
import { fileSha256, readCatalogFile } from '../lib/server/catalog-files';
import { saveProductionFile } from '../lib/server/production-storage';
import { readCloudProductionState, writeCloudProductionState } from '../lib/server/production-cloud-state';
import { savedProductionRender } from '../lib/server/production-render-cache';
import { cleanupReplacedFiles, queueReplacedFiles } from '../lib/server/production-replaced-files';

process.loadEnvFile('.env.local');
const output = 'output/production-replace-20260907';
const db = catalogDatabase();
const key = `smoke-${randomUUID()}`;
const checks: Record<string, unknown> = {};
const token = randomBytes(32).toString('hex');
const tokenHash = fileSha256(token);
const user = (await db.query('SELECT id FROM users WHERE email=$1 AND NOT disabled', [process.env.CATALOG_LOGIN_EMAIL])).rows[0];
assert.ok(user);
await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')", [tokenHash, user.id]);
const headers = { Cookie: `catalog_session=${token}`, Origin: 'http://localhost:3000' };
const timings: Record<string, number> = {};
async function get(url: string) {
  const start = performance.now();
  const response = await fetch(`http://localhost:3000${url}`, { headers });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, `${url}: ${bytes.toString().slice(0, 300)}`);
  timings[url.split('?')[0]] = Math.round(performance.now() - start);
  return bytes;
}
try {
  const main = await readCloudProductionState();
  checks.mainRevision = main.revision;
  assert.equal(JSON.parse((await get('/api/wps-production')).toString()).revision, main.revision);
  const styles = JSON.parse((await get('/api/catalog/styles')).toString());
  assert.equal(styles.total, 21);
  const thumbnails = (await db.query('SELECT thumbnail_file_id FROM garment_asset_versions ORDER BY id LIMIT 4')).rows;
  for (const row of thumbnails) assert.ok((await get(`/api/catalog/files/${row.thumbnail_file_id}`)).length > 100);
  checks.catalogThumbnails = 4;
  const first = main.units.find(unit => unit.artwork)!;
  await get(first.artwork!.url);
  assert.equal((await fetch(`http://localhost:3000${first.artwork!.url}`)).status, 401);
  const prepareStart = performance.now();
  for (let i = 0; i < 20; i++) {
    const response = await fetch('http://localhost:3000/api/logos/prepare', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256: first.artwork!.validation.sha256, operationId: randomUUID() }) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, 'ready');
  }
  timings.prepareAverageMs = Math.round((performance.now() - prepareStart) / 20);
  checks.repeatedUploadPreflight = 20;
  console.log('PASS cloud login, 4 thumbnails, image auth, 20 no-upload reuses');

  process.env.WPS_PRODUCTION_STATE_KEY = key;
  await catalogTransaction(client => writeCloudProductionState(client, main));
  const oldState = await readCloudProductionState();
  const version = oldState.mockupVersions.find(v => v.garment && v.unitIds.some(id => oldState.units.find(u => u.id === id)?.artwork))!;
  const initial = oldState.units.find(unit => version.unitIds.includes(unit.id) && unit.artwork && unit.placement)!;
  initial.placement!.rotation += Math.random() * .01 + .1;
  initial.gateA = null;
  oldState.revision++;
  await catalogTransaction(client => writeCloudProductionState(client, oldState));
  const oldUnits = version.unitIds.map(id => oldState.units.find(unit => unit.id === id)!);
  const before = await savedProductionRender(version, oldUnits);
  const changed = structuredClone(oldState);
  const edited = changed.units.find(unit => version.unitIds.includes(unit.id) && unit.artwork && unit.placement)!;
  edited.placement!.rotation += 0.25;
  edited.gateA = null;
  changed.revision++;
  await catalogTransaction(client => writeCloudProductionState(client, changed));
  // A result from the old input arrives after the newer input is authoritative.
  const changedVersion = changed.mockupVersions.find(v => v.id === version.id)!;
  const nextUnits = changedVersion.unitIds.map(id => changed.units.find(u => u.id === id)!);
  const after = await savedProductionRender(changedVersion, nextUnits);
  assert.notEqual(after.file.id, before.file.id);
  await savedProductionRender(version, oldUnits);
  const current = (await db.query('SELECT file_id FROM production_renders WHERE state_key=$1 AND version_id=$2', [key, version.id])).rows[0];
  assert.equal(current.file_id, after.file.id);
  const repeat = await savedProductionRender(changedVersion, nextUnits);
  assert.equal(repeat.file.id, after.file.id);
  const uploads = (await db.query('SELECT upload_count FROM files WHERE id=$1', [after.file.id])).rows[0].upload_count;
  assert.equal(uploads, 1);
  checks.renderReplacement = { old: before.file.id, current: after.file.id, lateResultRejected: true, repeatedRenderReused: true, uploadCount: uploads };
  const replaced = await cleanupReplacedFiles();
  // The open production page may already have completed the same queued deletion.
  await assertObjectDeleted(before.file.id);
  assert.deepEqual(replaced.failures, []);
  await assert.rejects(() => readCatalogFile(before.file.id));
  checks.immediateDeletion = replaced;
  console.log('PASS actual cloud replacement, late result rejected, render reuse, old image physically deleted immediately');

  const pixels = await sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
  const parallel = await Promise.all(Array.from({ length: 5 }, () => saveProductionFile(pixels, 'replace-canary.png')));
  assert.equal(new Set(parallel.map(file => file.id)).size, 1);
  const canary = parallel[0];
  assert.equal(fileSha256((await readCatalogFile(canary.id)).bytes), canary.sha256);
  assert.equal((await db.query('SELECT upload_count FROM files WHERE id=$1', [canary.id])).rows[0].upload_count, 1);
  await catalogTransaction(client => queueReplacedFiles(client, [canary.id]));
  // The real Web read returns first; its Next after callback removes our canary.
  const responseStart = performance.now();
  await get('/api/wps-production');
  timings.readBeforeCleanupMs = Math.round(performance.now() - responseStart);
  const deadline = Date.now() + 45_000;
  let deleted = false;
  while (Date.now() < deadline) {
    const row = (await db.query('SELECT gc_state FROM files WHERE id=$1', [canary.id])).rows[0];
    if (row.gc_state === 'deleted') { deleted = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(deleted, 'real Web after callback must delete without a worker');
  await assert.rejects(() => readCatalogFile(canary.id));
  await assertObjectDeleted(canary.id);
  checks.requestCleanup = { fiveConcurrentWritesOneUpload: true, youngObjectDeleted: true, readbackAbsent: true, withoutWorker: true };
  console.log('PASS actual HTTP after-response cleanup, single upload, and OSS physical deletion readback');

} finally {
  await catalogTransaction(async client => {
    const files = (await client.query('SELECT file_id FROM production_renders WHERE state_key=$1', [key])).rows;
    await queueReplacedFiles(client, files.map(file => file.file_id));
    for (const table of ['production_save_receipts', 'production_file_refs', 'production_renders', 'production_states']) await client.query(`DELETE FROM ${table} WHERE state_key=$1`, [key]);
  });
  checks.fixtureCleanup = await cleanupReplacedFiles();
  await db.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]);
  process.env.WPS_PRODUCTION_STATE_KEY = 'main';
  checks.mainRevisionAfter = (await readCloudProductionState()).revision;
  await writeFile(`${output}/cloud-smoke.json`, JSON.stringify({ at: new Date().toISOString(), checks, timings, mainStateUntouched: true }, null, 2));
  await closeCatalogDatabase();
}
