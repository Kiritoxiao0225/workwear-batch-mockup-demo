import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { catalogDatabase, catalogTransaction, closeCatalogDatabase } from '../lib/server/catalog-database';
import { fileSha256, readCatalogFile } from '../lib/server/catalog-files';
import { saveProductionFile, persistProductionReferences, productionFileReferences, productionStateKey } from '../lib/server/production-storage';
import { assertWpsProductionState } from '../lib/server/wps-production-store';
import { writeCloudProductionState } from '../lib/server/production-cloud-state';

process.loadEnvFile('.env.local');
const directory = process.argv[2];
if (!directory || !directory.startsWith('output/')) throw new Error('请指定已冻结迁移清单的 output 目录');
const manifest = JSON.parse(await readFile(path.join(directory, 'migration-manifest.json'), 'utf8'));
const source = await readFile('data/wps-production-state.json');
assert.equal(fileSha256(source), manifest.stateSha256, '本地生产状态已变化，请重新冻结迁移清单');
await mkdir(path.join(directory, 'migration-receipts'), { recursive: true });
try {
  for (const file of manifest.files) {
    const bytes = await readFile(path.join('public', file.url));
    assert.equal(fileSha256(bytes), file.sha256, '迁移源文件已变化');
    const saved = await saveProductionFile(bytes, path.basename(file.url));
    const verified = await readCatalogFile(saved.id);
    assert.equal(fileSha256(verified.bytes), file.sha256);
    await writeFile(path.join(directory, 'migration-receipts', `${file.sha256}.json`), JSON.stringify({ ...file, fileId: saved.id, url: saved.url, originalUrl: file.url, verifiedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ file: path.basename(file.url), fileId: saved.id, verified: true }));
  }
  const state = await persistProductionReferences(JSON.parse(source.toString()));
  assertWpsProductionState(state);
  assert.equal(fileSha256(await readFile('data/wps-production-state.json')), manifest.stateSha256, '迁移期间本地状态已更新；尚未切换云端');
  await catalogTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('production_initial_migration'))");
    const existing = (await client.query('SELECT revision,state_jsonb FROM production_states WHERE state_key=$1', [productionStateKey()])).rows[0];
    if (existing) { assert.deepEqual(existing.state_jsonb, state, '云端已有不同的生产状态，禁止覆盖'); return; }
    await writeCloudProductionState(client, state);
  });
  const restored = (await catalogDatabase().query('SELECT state_jsonb FROM production_states WHERE state_key=$1', [productionStateKey()])).rows[0].state_jsonb;
  assert.deepEqual(restored, state);
  const refs = productionFileReferences(state);
  const storedRefs = await catalogDatabase().query('SELECT count(*)::int AS count FROM production_file_refs WHERE state_key=$1', [productionStateKey()]);
  assert.equal(storedRefs.rows[0].count, refs.length);
  const receipt = { revision: state.revision, records: state.records.length, units: state.units.length, references: refs.length, uniqueFiles: new Set(refs.map(ref => ref.id)).size, sourceStateSha256: manifest.stateSha256, cloudReadback: true, switchedRuntime: false };
  await writeFile(path.join(directory, 'migration-verification.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { await closeCatalogDatabase(); }
