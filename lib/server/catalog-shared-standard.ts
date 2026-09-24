import { projectStandard, type CatalogDetail, type CatalogStyle, type PlacementStandard } from '@/lib/catalog';
import { SOP_STRUCTURES } from '@/lib/sop-placement';
import { catalogReferenceType, hasTemplateLandmarks } from '@/lib/catalog-placement-suggestions';
import { compareSilhouettes, garmentSilhouette } from './catalog-alignment';

export type SharedStandard = { specification: PlacementStandard; colorName: string; standardId: string };
type Source = { detail: CatalogDetail; bytes: Buffer };
const confirmedOf = (detail: CatalogDetail, face: 'front' | 'back') => {
  const view = detail.views.find(v => v.face === face);
  const version = view?.history.find(s => s.id === view.confirmedId && s.status === 'confirmed');
  return view && version ? { view, version } : null;
};

/** Identity of the style's confirmed faces, for cache keys: changes when any color confirms or re-confirms. */
export function styleConfirmationKey(style: Pick<CatalogStyle, 'colors'>, targetId: string) {
  return style.colors.filter(c => c.id !== targetId).map(c => [c.id, (c.calibrationFaces ?? []).map(f => f.confirmedId ?? (f.status === 'confirmed' ? 'confirmed' : null))]);
}

/**
 * Structure points are marked once per style: a face without its own confirmed standard uses
 * another color's confirmed one when the silhouettes line up (the same check as
 * 应用到同款其他颜色). Read-only; a color whose outline differs keeps its estimate.
 */
export async function sharedStyleStandards(target: Pick<CatalogDetail, 'id' | 'layout' | 'views' | 'namespace' | 'styleCode'>, targetBytes: Buffer, style: Pick<CatalogStyle, 'colors' | 'referenceVariantId'>, load: (id: string) => Promise<Source>) {
  const out: Partial<Record<'front' | 'back', SharedStandard>> = {};
  // A face confirmed with untouched template points counts as unconfirmed here too.
  const longSleeve = catalogReferenceType(target.namespace ?? '', target.styleCode ?? '').longSleeve;
  const needed = target.views.filter(v => { const own = v.history.find(s => s.id === v.confirmedId && s.status === 'confirmed')?.specification; return !own || (SOP_STRUCTURES.includes(own.structureType) && hasTemplateLandmarks(own, v.face, longSleeve)); });
  if (!needed.length) return out;
  const candidates = style.colors.filter(c => c.id !== target.id && c.layout === target.layout && (c.calibrationFaces ?? []).some(f => f.confirmedId || f.status === 'confirmed'))
    .sort((a, b) => Number(b.id === style.referenceVariantId) - Number(a.id === style.referenceVariantId));
  const sources = new Map<string, Promise<Source>>();
  for (const view of needed) {
    // A few candidates are enough: colors of one style normally share one render.
    const colors = candidates.filter(c => (c.calibrationFaces ?? []).some(f => f.face === view.face && (f.confirmedId || f.status === 'confirmed'))).slice(0, 3);
    const silhouette = colors.length ? await garmentSilhouette(targetBytes, view.crop) : null;
    if (!silhouette) continue;
    for (const color of colors) {
      if (!sources.has(color.id)) sources.set(color.id, load(color.id));
      const source = await sources.get(color.id)!;
      const confirmed = confirmedOf(source.detail, view.face);
      if (!confirmed || !SOP_STRUCTURES.includes(confirmed.version.specification.structureType) || hasTemplateLandmarks(confirmed.version.specification, view.face, catalogReferenceType(source.detail.namespace, source.detail.styleCode).longSleeve)) continue;
      const comparison = compareSilhouettes(await garmentSilhouette(source.bytes, confirmed.view.crop), silhouette);
      if (comparison.status !== 'aligned') continue;
      let specification: PlacementStandard;
      try { specification = projectStandard(confirmed.version.specification, comparison.alignment); } catch { continue; }
      out[view.face] = { specification, colorName: source.detail.colorName, standardId: confirmed.version.id };
      break;
    }
  }
  return out;
}
