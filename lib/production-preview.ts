import type { ArtworkValidation, ProductionMockupVersion, ProductionPlacement, ProductionUnit, WpsProductionState } from '@/lib/wps-production';
import { MOCKUP_SIZE_POLICY, MOCKUP_BODY_WIDTH_CM, printSizeCm, GarmentBodyScaleError } from './production-sizing';
import { catalogPositionKey, productionPlacementGeometry, type GarmentBinding } from '@/lib/production-garment';
import { artworkBlockingAmbiguities, artworkProcessingRoute } from '@/lib/task-review-analysis';
import { WPS_COMPOSITOR_VERSION } from './confirmation-frame';

export type ArtworkDimensions = Pick<ArtworkValidation, 'width' | 'height' | 'contentBounds'>;

/** A sync or unrelated save must not erase verified, unchanged preview geometry. */
export function reuseProductionGeometry(incoming: WpsProductionState, previous: WpsProductionState | null): WpsProductionState {
  if (!previous || incoming.batchId !== previous.batchId) return incoming;
  const source = (garment: GarmentBinding) => JSON.stringify(garment, (key, value) => key === 'bodyScale' ? undefined
    : value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return { ...incoming, units: incoming.units.map(unit => {
    const old = previous.units.find(candidate => candidate.id === unit.id);
    let garment = unit.garment, artwork = unit.artwork;
    if (garment && old?.garment && garment.views.some(view => !view.bodyScale) && source(garment) === source(old.garment)) {
      garment = { ...garment, views: garment.views.map(view => ({ ...view, bodyScale: view.bodyScale ?? old.garment!.views.find(candidate => candidate.id === view.id)?.bodyScale })) };
    }
    if (artwork && old?.artwork && !artwork.validation.contentBounds && artwork.url === old.artwork.url
      && artwork.validation.sha256 === old.artwork.validation.sha256) {
      artwork = { ...artwork, validation: { ...artwork.validation, contentBounds: old.artwork.validation.contentBounds } };
    }
    return garment === unit.garment && artwork === unit.artwork ? unit : { ...unit, garment, artwork };
  }) };
}

/** Unrelated task saves must not reload every garment preview. Version.updatedAt is batch-wide. */
export function productionPreviewRevision(version: ProductionMockupVersion, units: ProductionUnit[]) {
  return JSON.stringify([WPS_COMPOSITOR_VERSION, version.garment?.assetVersionId, version.garment?.sha256,
    units.filter(unit => version.unitIds.includes(unit.id)).sort((a, b) => a.id.localeCompare(b.id))
      .map(unit => [unit.id, unit.updatedAt, unit.artwork?.url ?? null, unit.artwork?.validation.sha256 ?? null])]);
}

/** Calibration can change without a task save. Re-read its preview while keeping
 * the task revision guard based on persisted state, not read-only hydration.
 */
export function productionPreviewCalibrationKey(units: ProductionUnit[]) {
  return JSON.stringify([...units].sort((a, b) => a.id.localeCompare(b.id)).map(unit => [unit.id,
    unit.garment?.views.map(view => view.bodyScale?.standardId ?? null)]));
}

export function artworkContentBounds(validation: ArtworkDimensions) {
  return validation.contentBounds ?? { left: 0, top: 0, width: validation.width, height: validation.height };
}
export function artworkAspectRatio(validation: ArtworkDimensions) {
  const bounds = artworkContentBounds(validation);
  return bounds.width / bounds.height;
}
export function initialTaskPlacement(unit: ProductionUnit, validation: ArtworkDimensions): ProductionPlacement {
  if (!unit.garment || !unit.placement) throw new Error('请先选择衣服款式、颜色和印花位置');
  const view = unit.garment.views.find(view => view.face === (unit.placement!.key === 'back' ? 'back' : 'front'));
  if (!view) throw new Error('缺少当前印花面的衣服图片');
  const placement = { ...unit.placement, sizePolicy: MOCKUP_SIZE_POLICY };
  if (!view.bodyScale) throw new GarmentBodyScaleError();
  const width = printSizeCm(placement, artworkAspectRatio(validation)).width / MOCKUP_BODY_WIDTH_CM * view.bodyScale.widthRatio;
  return { ...placement, manual: { ...taskPlacementAnchor(unit), width } };
}

/** Position markers do not need a measured body width or an artwork file. */
export function taskPlacementAnchor(unit: ProductionUnit) {
  if (!unit.garment || !unit.placement) throw new Error('请先选择衣服款式、颜色和印花位置');
  const placement = unit.placement;
  const view = unit.garment.views.find(view => view.face === (placement.key === 'back' ? 'back' : 'front'));
  if (!view) throw new Error('缺少当前印花面的衣服图片');
  if (placement.manual) return { centerX: placement.manual.centerX, centerY: placement.manual.centerY };
  const spec = view.standard?.specification;
  const position = spec?.positions.find(position => position.key === catalogPositionKey(placement));
  if (spec && position) return {
    centerX: spec.garmentFrame.x + (position.anchor.x + placement.offsetX / 100) * spec.garmentFrame.width,
    centerY: spec.garmentFrame.y + (position.anchor.y + placement.offsetY / 100) * spec.garmentFrame.height,
  };
  // Unsaved position candidates only; no garment measurement or approval is inferred.
  const centers: Record<ProductionPlacement['key'], [number, number]> = {
    leftChest: [0.64, 0.34], rightChest: [0.36, 0.34], frontCenter: [0.5, 0.44],
    back: [0.5, 0.38], leftSleeve: [0.81, 0.38], rightSleeve: [0.19, 0.38],
  };
  const [centerX, centerY] = placement.key === 'back' && placement.catalogPosition === 'upperBack' ? [0.5, 0.22] : centers[placement.key];
  return { centerX, centerY };
}
export function placementPreview(garment: GarmentBinding, placement: ProductionPlacement, validation: ArtworkDimensions) {
  return productionPlacementGeometry(garment, placement, artworkAspectRatio(validation));
}

export function productionArtworkStage(unit: ProductionUnit) {
  const attempt = [...unit.attempts].reverse().find(candidate => candidate.recipeFingerprint === unit.recipeFingerprint);
  if (attempt?.status === 'unknownSubmission') return '提交状态待核实';
  if (attempt?.status === 'queued') return '图案待处理';
  if (attempt?.status === 'submitted') return '已提交，等待处理';
  if (attempt?.status === 'processing') return '正在处理图案';
  if (unit.error || attempt?.status === 'failed' || unit.artwork?.validation.valid === false) return '图案处理失败';
  if ((unit.artwork && unit.artwork.recipeFingerprint !== unit.recipeFingerprint)
    || (!unit.artwork && !attempt && unit.attempts.length > 0)) return '图案要求已更新，需重新制作';
  if (!unit.artwork) {
    if (isTextOnlyArtwork(unit)) return '待制作文字';
    if (artworkProcessingRoute(unit) === 'blocked' || artworkBlockingAmbiguities(currentArtworkAmbiguities(unit)).length || !unit.instruction.trim()) return '待补充图案要求';
    if (!unit.materialId && !isReferenceTextArtwork(unit)) return '缺少原始素材';
    if (attempt?.status === 'completed') return '图案文件缺失，需重新制作';
    return '待制作图案';
  }
  return unit.gateB?.fingerprint === unit.artwork.validation.sha256 ? 'Logo 已确认' : '待核对 Logo';
}
import { currentArtworkAmbiguities, isReferenceTextArtwork, isTextOnlyArtwork } from './artwork-reference';
