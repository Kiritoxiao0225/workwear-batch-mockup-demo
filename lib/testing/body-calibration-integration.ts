import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CatalogUser, PlacementStandard } from '@/lib/catalog';
import { bindingFromCatalog } from '@/lib/production-garment';
import { initialTaskPlacement, placementPreview } from '@/lib/production-preview';
import { emptyWpsProductionState, importTaskReviews } from '@/lib/wps-production';
import { taskReviewFixture } from './task-review-fixture';
import { importCatalogAsset } from '../server/catalog-import';
import { catalogDetail, savePlacementStandard } from '../server/catalog-repository';
import { readConfirmedBodyScales } from '../server/catalog-body-calibration';
import { withGarmentBodyScale, withProductionPreviewGeometry } from '../server/wps-garment-sizing';
import { verifyGarmentBinding } from '../server/wps-production-garments';

/** Called only by the existing isolated PostgreSQL integration runner. */
export async function verifyBodyCalibrationIntegration(actor: CatalogUser, spec: PlacementStandard, bytes: Buffer) {
  const source = { namespace: 'calibration-integration', styleCode: 'CALIBRATION-ONLY', colorName: 'navy', layout: 'front_back' as const,
    bytes, filename: 'calibration.png', sources: [], provenance: {} };
  const imported = await importCatalogAsset(source), detail = await catalogDetail(imported.variantId, undefined, '00000000-0000-0000-0000-000000000001');
  const binding = bindingFromCatalog(detail, { selection: 'exact', colorText: detail.colorName, evidence: 'isolated fixture' });
  const missing = await withGarmentBodyScale(binding);
  assert(missing.views.every(view => !view.bodyScale));
  const state = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[0]]);
  const unit = state.units[0];
  unit.garment = binding;
  unit.placement = { ...unit.placement!, templateVersion: 'catalog-v1', sizePolicy: 'body-55-v1', manual: { centerX: .6, centerY: .4, width: .1 }, rotation: 12 };
  const before = structuredClone(state);
  assert.throws(() => initialTaskPlacement(unit, { width: 1, height: 1 }), /衣身宽度/);
  const front = detail.views.find(view => view.face === 'front')!;
  const draft = { viewId: front.id, assetVersionId: detail.assetVersionId, expectedRevision: 0, confirm: false, specification: spec };
  await savePlacementStandard(draft, actor, '00000000-0000-0000-0000-000000000001');
  assert.equal((await readConfirmedBodyScales(binding, binding.views)).size, 0);
  const confirmed = await savePlacementStandard({ ...draft, expectedRevision: 1, confirm: true }, actor, '00000000-0000-0000-0000-000000000001');
  const hydrated = await withProductionPreviewGeometry(state);
  const adopted = hydrated.units[0].garment!;
  assert.equal(adopted.views[0].bodyScale?.standardId, confirmed.standardId);
  assert.equal(adopted.views[1].bodyScale, undefined);
  assert(adopted.views.every(view => view.standard === null));
  assert.deepEqual(hydrated.units[0].placement, before.units[0].placement);
  assert.deepEqual(state, before);
  const placed = initialTaskPlacement(hydrated.units[0], { width: 1, height: 1 });
  assert.equal(placed.manual!.centerX, .6); assert.equal(placed.manual!.centerY, .4); assert.equal(placed.rotation, 12);
  assert(placementPreview(adopted, placed, { width: 1, height: 1 }).width > 0);
  await verifyGarmentBinding(adopted);
  const altered = structuredClone(spec);
  altered.landmarks.find(point => point.key === 'rightArmpit')!.point.x -= .1;
  await savePlacementStandard({ ...draft, expectedRevision: 2, specification: altered }, actor, '00000000-0000-0000-0000-000000000001');
  assert.equal((await readConfirmedBodyScales(binding, binding.views)).get(front.id)!.standardId, confirmed.standardId);
  const newer = await savePlacementStandard({ ...draft, expectedRevision: 3, specification: altered, confirm: true }, actor, '00000000-0000-0000-0000-000000000001');
  assert.equal((await withGarmentBodyScale(binding)).views[0].bodyScale!.standardId, newer.standardId);
  assert.deepEqual((await withGarmentBodyScale(adopted)).views[0].bodyScale, adopted.views[0].bodyScale);
  await verifyGarmentBinding(adopted);
  const corrupt = structuredClone(adopted); corrupt.views[0].bodyScale!.widthRatio += .01;
  await assert.rejects(() => verifyGarmentBinding(corrupt), /基准已变化/);
  for (const change of [{ sha256: 'f'.repeat(64) }, { assetVersionId: randomUUID() }, { variantId: randomUUID() }, { styleId: randomUUID() }, { width: binding.width + 1 }]) {
    assert.equal((await readConfirmedBodyScales({ ...binding, ...change }, binding.views)).size, 0);
  }
  const recropped = structuredClone(binding); recropped.views[0].crop.width -= .01;
  assert.equal((await readConfirmedBodyScales(recropped, recropped.views)).size, 0);
  const other = await importCatalogAsset({ ...source, colorName: 'other color' });
  const otherBinding = bindingFromCatalog(await catalogDetail(other.variantId, undefined, '00000000-0000-0000-0000-000000000001'), { selection: 'exact', colorText: 'other color', evidence: 'isolated' });
  assert.equal((await readConfirmedBodyScales(otherBinding, otherBinding.views)).size, 0);
  const wrongFace = structuredClone(binding);
  wrongFace.views[1].bodyScale = adopted.views[0].bodyScale;
  await assert.rejects(() => withGarmentBodyScale(wrongFace), /校准记录与底图不一致/);
  const pinnedState = structuredClone(before);
  pinnedState.units[0].gateA = { actor: actor.displayName, confirmedAt: new Date().toISOString(), fingerprint: unit.planFingerprint };
  assert.deepEqual((await withProductionPreviewGeometry(pinnedState)).units, pinnedState.units);
}
