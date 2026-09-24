import { isDeepStrictEqual } from 'node:util';
import { withGarmentBodyScale } from './wps-garment-sizing';
import type { TaskReview } from '@/lib/batch-task-review';
import { bindingFromCatalog, matchProductionGarment, type GarmentBinding } from '@/lib/production-garment';
import { INTERNAL_TENANT_ID } from '@/lib/server/catalog-auth';
import { allCatalogStyles, catalogDetail } from '@/lib/server/catalog-repository';
import type { CatalogStyle } from '@/lib/catalog';

// The WPS workflow serves the internal tenant, which owns the existing catalog.
export async function productionCatalogStyles(): Promise<CatalogStyle[]> {
  return allCatalogStyles(INTERNAL_TENANT_ID);
}
export async function prepareCatalogReviews(reviews: TaskReview[]) {
  const styles = await productionCatalogStyles();
  const bindings = new Map<string, Promise<Awaited<ReturnType<typeof catalogDetail>>>>();
  return Promise.all(reviews.map(async review => ({ ...review, units: await Promise.all(review.units.map(async unit => {
    const match = matchProductionGarment(review.source, unit, styles);
    let garment: GarmentBinding | null = null;
    if (match.item) {
      const key = match.item.id;
      if (!bindings.has(key)) bindings.set(key, catalogDetail(key, match.item.assetVersionId, INTERNAL_TENANT_ID));
      garment = await withGarmentBodyScale(bindingFromCatalog(await bindings.get(key)!, match));
    }
    // Never accept a browser-supplied asset/standard snapshot as catalog truth.
    return { ...unit, garment, garmentMatchNote: match.evidence };
  })) })));
}
export async function verifyGarmentBinding(binding: GarmentBinding) {
  const detail = await catalogDetail(binding.variantId, binding.assetVersionId, INTERNAL_TENANT_ID);
  if (detail.styleId !== binding.styleId || detail.sha256 !== binding.sha256 || detail.imageUrl !== binding.imageUrl || detail.width !== binding.width || detail.height !== binding.height) throw new Error(`衣服底图身份或内容已变化：${binding.styleCode} ${binding.colorName}`);
  for (const pinned of binding.views) {
    const view = detail.views.find(view => view.id === pinned.id && view.face === pinned.face);
    if (!view || !isDeepStrictEqual(view.crop, pinned.crop)) throw new Error(`衣服视图已变化：${pinned.id}`);
    if (pinned.standard) {
      const standard = view.history.find(version => version.id === pinned.standard!.id && version.status === 'confirmed');
      if (!standard || !isDeepStrictEqual(standard.specification, pinned.standard.specification)) throw new Error(`位置标准身份或内容已变化：${pinned.standard.id}`);
    }
  }
  if (binding.views.some(view => view.bodyScale)) {
    const checked = await withGarmentBodyScale(binding);
    for (const view of binding.views) {
      if (view.bodyScale && !isDeepStrictEqual(view.bodyScale, checked.views.find(candidate => candidate.id === view.id)?.bodyScale)) throw new Error(`衣身尺寸基准已变化：${view.id}`);
    }
  }
  return detail;
}
