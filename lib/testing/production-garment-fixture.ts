import { bindingFromCatalog } from '@/lib/production-garment';
import { emptyStandard, type CatalogDetail, type CatalogStyle } from '@/lib/catalog';

export function catalogFixture(): CatalogDetail {
  const spec = { ...emptyStandard(), structureType: 'polo' as const, measuredWidthCm: 50,
    landmarks: [{ key: 'leftArmpit', label: '左腋点', point: { x: .225, y: .4 } }, { key: 'rightArmpit', label: '右腋点', point: { x: .775, y: .4 } }],
    positions: ['frontCenter', 'leftChest', 'rightChest', 'leftSleeve', 'rightSleeve', 'upperBack', 'backCenter'].map(key => ({ key: key as 'frontCenter', anchor: { x: 0.5, y: 0.5 }, printableArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, defaultSize: { width: 0.2, height: 0.2 } })) };
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return { id: id(1), styleId: id(2), assetVersionId: id(3), styleCode: 'B01SD', colorName: '活力黑', namespace: 'fixture', assetVersion: 1,
    filename: 'fixture.png', imageUrl: `/api/catalog/files/${id(4)}`, thumbnailUrl: `/api/catalog/files/${id(4)}`, width: 1000, height: 500, sha256: 'a'.repeat(64),
    layout: 'front_back', confirmedFaces: 2, faceCount: 2, hasDraft: false, isCurrent: true, sources: [], provenance: {}, versions: [],
    views: ['front', 'back'].map((face, index) => ({ id: id(5 + index), face: face as 'front' | 'back', crop: { x: index * 0.5, y: 0, width: 0.5, height: 1 }, revision: 1,
      latest: null, confirmedId: id(7 + index), history: [{ id: id(7 + index), revision: 1, status: 'confirmed', specification: spec, createdAt: '2026-09-05T00:00:00.000Z', createdBy: 'fixture', origin: 'manual' }],
    })),
  };
}
export function garmentFixture() { const binding = bindingFromCatalog(catalogFixture(), { selection: 'exact', colorText: '活力黑', evidence: 'B01SD-活力黑' }); return { ...binding, views: binding.views.map(view => ({ ...view, bodyScale: { widthRatio: .55, basis: 'alpha-torso-v1' as const } })) }; }
export function styleFixture(code: string, colors: string[], offset = 0): CatalogStyle {
  const detail = catalogFixture();
  const id = `00000000-0000-4000-8000-${String(100 + offset).padStart(12, '0')}`;
  return { id, styleCode: code, namespace: 'fixture', referenceVariantId: null, matchedIds: [], colors: colors.map((color, index) => ({ ...detail, id: `00000000-0000-4000-8000-${String(1000 + offset * 10 + index).padStart(12, '0')}`, styleId: id, styleCode: code, colorName: color })) };
}
