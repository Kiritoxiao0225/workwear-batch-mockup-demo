import type { GarmentBinding } from '@/lib/production-garment';
import { bodyScaleSchema } from '@/lib/production-sizing';
import type { WpsProductionState } from '@/lib/wps-production';

import { loadBodyGeometry } from './catalog-body-geometry';
export { torsoWidthRatio } from './catalog-body-geometry';

export async function withGarmentBodyScale(garment: GarmentBinding): Promise<GarmentBinding> {
  const confirmed = garment.views.map(view => {
    const spec = view.standard?.specification;
    const left = spec?.landmarks.find(point => point.key === 'leftArmpit');
    const right = spec?.landmarks.find(point => point.key === 'rightArmpit');
    if (!left || !right || !spec) return null;
    return bodyScaleSchema.parse({ widthRatio: Math.abs(right.point.x - left.point.x) * spec.garmentFrame.width, basis: 'confirmed-armpits' });
  });
  const widths = confirmed.some(value => !value) ? await loadBodyGeometry({ fileId: garment.imageUrl.split('/').at(-1)!, sha256: garment.sha256, width: garment.width, height: garment.height, crops: garment.views.map(view => view.crop) }) : [];
  return { ...garment, views: garment.views.map((view, i) => {
    const original = { ...view };
    delete original.bodyScale;
    const bodyScale = confirmed[i] ?? (widths[i] ? bodyScaleSchema.parse({ widthRatio: widths[i], basis: 'alpha-torso-v1' }) : null);
    return bodyScale ? { ...original, bodyScale } : original;
  }) };
}

/** Read prepared catalog geometry for legacy task snapshots without modifying
 * those snapshots or treating measurements as confirmations. Failed items retain
 * their missing scale, so their editor still reports the sizing problem.
 */
export async function withProductionPreviewGeometry(state: WpsProductionState): Promise<WpsProductionState> {
  const prepared = new Map<string, Promise<GarmentBinding>>();
  const results = await Promise.allSettled(state.units.map(async unit => {
    const garment = unit.garment;
    if (!garment || garment.views.every(view => view.bodyScale)) return unit;
    const key = JSON.stringify(garment);
    if (!prepared.has(key)) prepared.set(key, withGarmentBodyScale(garment));
    return { ...unit, garment: await prepared.get(key)! };
  }));
  return { ...state, units: results.map((result, index) => result.status === 'fulfilled' ? result.value : state.units[index]) };
}
