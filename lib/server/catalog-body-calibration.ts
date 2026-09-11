import { isDeepStrictEqual } from 'node:util';
import { alignmentSchema, projectStandard, standardSchema, type PlacementStandard } from '@/lib/catalog';
import type { GarmentBinding } from '@/lib/production-garment';
import { bodyScaleSchema } from '@/lib/production-sizing';
import { catalogDatabase } from './catalog-database';

export function confirmedArmpitScale(spec: PlacementStandard | undefined, standardId?: string) {
  const left = spec?.landmarks.find(point => point.key === 'leftArmpit');
  const right = spec?.landmarks.find(point => point.key === 'rightArmpit');
  if (!left || !right || !spec) return null;
  const parsed = bodyScaleSchema.safeParse({ widthRatio: Math.abs(right.point.x - left.point.x) * spec.garmentFrame.width,
    basis: 'confirmed-armpits', ...(standardId ? { standardId } : {}) });
  return parsed.success ? parsed.data : null;
}

/** Read only confirmations for the exact saved asset and face. No permanent
 * negative cache: confirming a previously unmarked image must be visible next read.
 * A saved standardId selects history, never silently upgrades an accepted width.
 */
export async function readConfirmedBodyScales(garment: GarmentBinding, views: GarmentBinding['views']) {
  const scales = new Map<string, NonNullable<ReturnType<typeof confirmedArmpitScale>>>();
  if (!views.length || !process.env.CATALOG_DATABASE_URL) return scales;
  const result = await catalogDatabase().query(`SELECT g.id,g.face,g.crop,p.id AS standard_id,p.specification,p.origin,
      src.specification AS source_specification,p.alignment
    FROM garment_views g JOIN garment_asset_versions a ON a.id=g.asset_version_id
    JOIN garment_variants v ON v.id=a.variant_id JOIN files f ON f.id=a.file_id
    JOIN jsonb_to_recordset($8::jsonb) wanted(view_id uuid,standard_id uuid) ON wanted.view_id=g.id
    JOIN placement_standard_versions p ON p.view_id=g.id AND p.status='confirmed'
      AND p.id=COALESCE(wanted.standard_id,g.confirmed_standard_id)
    LEFT JOIN placement_standard_versions src ON src.id=p.source_standard_id
    WHERE a.id=$1 AND a.variant_id=$2 AND v.style_id=$3 AND f.id=$4
      AND f.sha256=$5 AND f.width=$6 AND f.height=$7 AND f.status='ready' AND f.gc_state='active'`,
  [garment.assetVersionId, garment.variantId, garment.styleId, garment.imageUrl.split('/').at(-1), garment.sha256,
    garment.width, garment.height, views.map(view => ({ view_id: view.id, standard_id: view.bodyScale?.standardId ?? null }))]);
  for (const row of result.rows) {
    const view = views.find(view => view.id === row.id && view.face === row.face && isDeepStrictEqual(view.crop, row.crop));
    if (!view) continue;
    const spec = row.origin === 'inherited'
      ? projectStandard(standardSchema.parse(row.source_specification), alignmentSchema.parse(row.alignment))
      : standardSchema.parse(row.specification);
    const scale = confirmedArmpitScale(spec, row.standard_id);
    if (scale) scales.set(view.id, scale);
  }
  return scales;
}
