import assert from 'node:assert/strict';
import type { CatalogDetail, CatalogUser, PlacementStandard } from '@/lib/catalog';
import { importCatalogAsset } from '../server/catalog-import';
import { catalogDetail, savePlacementStandard, savePlacementStandardBatch } from '../server/catalog-repository';
import { catalogDatabase } from '../server/catalog-database';

/** Runs only against the isolated PostgreSQL database created by test:catalog. */
export async function verifyBatchConfirmationIntegration(actor: CatalogUser, spec: PlacementStandard, bytes: Buffer) {
  const source = { namespace: 'batch-confirmation-test', styleCode: 'BATCH-FACES', colorName: 'green', layout: 'front_back' as const,
    bytes, filename: 'batch-faces.png', sources: [], provenance: {} };
  const imported = await importCatalogAsset(source);
  const command = (detail: CatalogDetail) => ({ assetVersionId: detail.assetVersionId, confirm: true,
    views: detail.views.map(v => ({ viewId: v.id, expectedRevision: v.revision,
      specification: { ...structuredClone(spec), note: `${v.face} edits`, positions: [{ ...spec.positions[0], key: v.face === 'front' ? 'frontCenter' as const : 'backCenter' as const }] } })) });
  let detail = await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001');
  const first = command(detail);
  await assert.rejects(() => savePlacementStandardBatch(first, { ...actor, role: 'viewer' }, '00000000-0000-0000-0000-000000000001'), /查看权限/);
  await assert.rejects(() => savePlacementStandardBatch({ ...first, views: [first.views[0]] }, actor, '00000000-0000-0000-0000-000000000001'), /所有面/);
  await assert.rejects(() => savePlacementStandardBatch({ ...first, views: [first.views[0], first.views[0]] }, actor, '00000000-0000-0000-0000-000000000001'), /重复/);
  await savePlacementStandardBatch({ ...first, confirm: false }, actor, '00000000-0000-0000-0000-000000000001');
  detail = await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001');
  assert.equal(detail.confirmedFaces, 0);
  assert(detail.views.every(v => v.latest?.status === 'draft' && v.revision === 1));
  await savePlacementStandardBatch(command(detail), actor, '00000000-0000-0000-0000-000000000001');
  detail = await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001');
  assert.equal(detail.confirmedFaces, 2);
  assert(detail.views.every(v => v.latest?.status === 'confirmed' && v.revision === 2 && v.latest.specification.note === `${v.face} edits`));

  const stale = command(detail), back = stale.views[1];
  await savePlacementStandard({ ...back, assetVersionId: detail.assetVersionId, confirm: false }, actor, '00000000-0000-0000-0000-000000000001');
  const beforeConflict = await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001');
  await assert.rejects(() => savePlacementStandardBatch(stale, actor, '00000000-0000-0000-0000-000000000001'), /背面已被更新/);
  assert.deepEqual(await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001'), beforeConflict);
  const invalid = command(beforeConflict); invalid.views[1].specification.positions = [];
  await assert.rejects(() => savePlacementStandardBatch(invalid, actor, '00000000-0000-0000-0000-000000000001'), /背面.*至少需要/);
  assert.deepEqual(await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001'), beforeConflict);

  // Fail the second INSERT after the first face has been written: both standards and audit must roll back.
  const db = catalogDatabase();
  const auditBefore = (await db.query('SELECT count(*)::int AS count FROM audit_events')).rows[0].count;
  await db.query(`CREATE FUNCTION test_reject_batch_back() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.view_id='${back.viewId}'::uuid THEN RAISE EXCEPTION 'isolated second face write failure'; END IF; RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER test_reject_batch_back BEFORE INSERT ON placement_standard_versions FOR EACH ROW EXECUTE FUNCTION test_reject_batch_back()');
  try {
    await assert.rejects(() => savePlacementStandardBatch(command(beforeConflict), actor, '00000000-0000-0000-0000-000000000001'), /isolated second face/);
    assert.deepEqual(await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001'), beforeConflict);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM audit_events')).rows[0].count, auditBefore);
  } finally {
    await db.query('DROP TRIGGER test_reject_batch_back ON placement_standard_versions');
    await db.query('DROP FUNCTION test_reject_batch_back()');
  }
  const current = command(beforeConflict);
  const concurrent = await Promise.allSettled([savePlacementStandardBatch(current, actor, '00000000-0000-0000-0000-000000000001'), savePlacementStandardBatch(current, actor, '00000000-0000-0000-0000-000000000001')]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(r => r.status === 'rejected').length, 1);
  detail = await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001');
  assert(detail.views.every(v => v.latest?.status === 'confirmed'));
  assert.deepEqual(detail.views.map(v => v.revision), beforeConflict.views.map(v => v.revision + 1));

  const single = await importCatalogAsset({ ...source, styleCode: 'BATCH-SINGLE', layout: 'front_only' });
  const singleDetail = await catalogDetail(single.variantId, undefined, '00000000-0000-0000-0000-000000000001');
  const wrongColor = command(detail); wrongColor.views[1].viewId = singleDetail.views[0].id;
  await assert.rejects(() => savePlacementStandardBatch(wrongColor, actor, '00000000-0000-0000-0000-000000000001'), /所有面/);
  await savePlacementStandardBatch(command(singleDetail), actor, '00000000-0000-0000-0000-000000000001');
  assert.equal((await catalogDetail(single.variantId, undefined, '00000000-0000-0000-0000-000000000001')).confirmedFaces, 1);
}
