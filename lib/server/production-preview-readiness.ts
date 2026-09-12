import type { ProductionUnit } from '@/lib/wps-production';
import { productionPreviewReadiness } from '@/lib/production-preview';
import { GarmentBodyScaleError, MISSING_BODY_SCALE_MESSAGE } from '@/lib/production-sizing';
import { withGarmentBodyScale } from './wps-garment-sizing';

/** Uses the existing SHA/crop/face-bound catalog reader and alpha torso algorithm.
 * Never copies another colour, writes a standard, or changes a fixed snapshot.
 */
export async function resolveProductionPreviewUnit(unit: ProductionUnit, options: { fixed?: boolean } = {}) {
  if (!unit.garment || unit.gateA || options.fixed) return unit;
  const garment = await withGarmentBodyScale(unit.garment);
  return { ...unit, garment };
}

export async function prepareProductionPreviewUnit(unit: ProductionUnit, options: { fixed?: boolean } = {}) {
  const resolved = await resolveProductionPreviewUnit(unit, options);
  const ready = productionPreviewReadiness(resolved, options);
  if (ready.garmentIssue) throw ready.garmentIssue === MISSING_BODY_SCALE_MESSAGE ? new GarmentBodyScaleError() : new Error(ready.garmentIssue);
  if (ready.artworkIssue) throw new Error(ready.artworkIssue);
  return { ...resolved, placement: ready.placement };
}
