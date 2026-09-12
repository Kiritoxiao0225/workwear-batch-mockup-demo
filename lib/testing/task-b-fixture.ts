/** Synthetic task data only; no live WPS/order/catalog identifiers are required. */
import { emptyWpsProductionState, importTaskReviews, type ArtworkValidation, type ProductionUnit } from '../wps-production';
import { taskReviewFixture } from './task-review-fixture';
import { garmentFixture } from './production-garment-fixture';
import { MOCKUP_SIZE_POLICY } from '../production-sizing';

export function taskBFixture(withArtwork = true) {
  const state = importTaskReviews(emptyWpsProductionState(new Date('2026-09-12T00:00:00Z')), [taskReviewFixture()[0]]);
  const source = state.records[0].source;
  source.requirementText = '货号:B01SD-活力黑-L 左胸：康悦';
  source.productStyleText = 'B01SD-活力黑-L';
  const unit = state.units[0];
  Object.assign(unit, { materialId: null, referenceMaterialIds: [], sourceScope: 'subject', textMode: 'replace', exactText: '康悦',
    instruction: '制作文字“康悦”', layoutNote: '', generationPrompt: undefined, ambiguities: [], route: 'deterministic' });
  unit.garment = garmentFixture();
  unit.garment.views.forEach(view => { view.standard = null; });
  unit.placement = { key: 'leftChest', templateVersion: 'catalog-v1', sizeMode: 'widthCm', sizePolicy: MOCKUP_SIZE_POLICY,
    widthCm: 9, offsetX: 0, offsetY: 0, rotation: 0 };
  if (withArtwork) unit.artwork = taskBArtwork(unit);
  else unit.artwork = null;
  const version = state.mockupVersions[0];
  version.garment = unit.garment;
  return { state, source, unit, version };
}

export function taskBArtwork(unit: ProductionUnit, sha256 = 'b'.repeat(64)) {
  const validation: ArtworkValidation = { valid: true, mimeType: 'image/png', width: 800, height: 600,
    contentBounds: { left: 150, top: 230, width: 400, height: 80 }, byteLength: 1024, sha256,
    transparentPixelRatio: .8, visiblePixelRatio: .2, checkedAt: '2026-09-12T00:00:00Z', ruleVersion: 'transparent-artwork-v1', issues: [] };
  return { url: '/uploads/logos/task-b-synthetic.png', name: 'task-b-synthetic.png', validation,
    recipeFingerprint: unit.recipeFingerprint, createdAt: validation.checkedAt };
}
