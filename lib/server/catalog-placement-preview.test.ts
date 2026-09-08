import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { catalogPlacementPreview } from './catalog-placement-preview';
import { readCatalogFile } from './catalog-files';
import { catalogFixture } from '@/lib/testing/production-garment-fixture';
import { emptyStandard } from '@/lib/catalog';

vi.mock('./catalog-files', () => ({ readCatalogFile: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function freshDetail() { const detail = structuredClone(catalogFixture()); detail.thumbnailUrl = `/api/catalog/files/${randomUUID()}`; return detail; }
describe('catalog placement preview', () => {
  it('aligns each face to its own actual alpha bounds, without changing saved data', async () => {
    const detail = freshDetail();
    detail.namespace = 'normalized-garments-v1'; detail.styleCode = '301SRX';
    detail.views.forEach(v => { v.latest = null; v.history = []; v.confirmedId = null; });
    const image = Buffer.from('<svg width="400" height="200"><rect x="10" y="20" width="140" height="170" fill="red"/><rect x="245" y="10" width="150" height="180" fill="red"/></svg>');
    const bytes = await sharp(image).png().toBuffer();
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    const before = JSON.stringify(detail);
    const result = await catalogPlacementPreview(detail);
    expect(result.faces).toHaveLength(2);
    expect(result.faces[0].frame!.x).toBeLessThan(result.faces[1].frame!.x);
    expect(result.faces.every(f => f.specification.positions.length > 0)).toBe(true);
    expect(JSON.stringify(detail)).toBe(before);
  });
  it('preserves saved drafts and confirmed coordinates exactly instead of inserting new suggestions', async () => {
    const detail = freshDetail();
    const saved = { ...emptyStandard(), note: 'keep my draft' };
    detail.views.forEach(v => { v.latest = { id: v.id, revision: 1, status: 'draft', specification: saved, createdAt: '2026-09-05T00:00:00.000Z', createdBy: 'reviewer', origin: 'manual' }; });
    const result = await catalogPlacementPreview(detail);
    expect(result.faces.every(f => f.specification.note === saved.note && f.specification.positions.length === 0)).toBe(true);
    expect(readCatalogFile).not.toHaveBeenCalled();
  });
  it('reports opaque photos as needing boundary adjustment, and propagates file failures', async () => {
    const detail = freshDetail();
    detail.views.forEach(v => { v.latest = null; });
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: await sharp({ create: { width: 400, height: 200, channels: 3, background: 'white' } }).png().toBuffer() } as Awaited<ReturnType<typeof readCatalogFile>>);
    const result = await catalogPlacementPreview(detail);
    expect(result.faces.every(f => f.frame === null && f.basis.includes('调整衣服边界'))).toBe(true);
    expect(result.faces.every(f => f.specification.positions.length === 0 && f.specification.exclusions.length === 0 && f.specification.landmarks.length === 0)).toBe(true);
    detail.assetVersionId = randomUUID();
    vi.mocked(readCatalogFile).mockRejectedValue(new Error('文件内容校验失败'));
    await expect(catalogPlacementPreview(detail)).rejects.toThrow('文件内容校验失败');
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: await sharp({ create: { width: 400, height: 200, channels: 3, background: 'white' } }).png().toBuffer() } as Awaited<ReturnType<typeof readCatalogFile>>);
    await expect(catalogPlacementPreview(detail)).resolves.toHaveProperty('assetVersionId', detail.assetVersionId);
  });
  it('shares immutable geometry across concurrent opens but always uses the latest saved specification', async () => {
    const detail = freshDetail();
    const bytes = await sharp(Buffer.from('<svg width="400" height="200"><rect x="10" y="20" width="140" height="170" fill="red"/><rect x="245" y="10" width="150" height="180" fill="red"/></svg>')).png().toBuffer();
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    const [first, second] = await Promise.all([catalogPlacementPreview(detail), catalogPlacementPreview(detail)]);
    expect(second).toEqual(first);
    expect(readCatalogFile).toHaveBeenCalledTimes(1);
    const specification = { ...emptyStandard(), note: 'new draft after opening' };
    detail.views[0].latest = { id: randomUUID(), revision: 2, status: 'draft', specification, createdAt: new Date().toISOString(), createdBy: 'reviewer', origin: 'manual' };
    const refreshed = await catalogPlacementPreview(detail);
    expect(refreshed.faces[0].specification).toEqual(specification);
    expect(refreshed.faces[1]).toEqual(first.faces[1]);
    expect(readCatalogFile).toHaveBeenCalledTimes(1);
  });
  it('recomputes geometry when the asset version, thumbnail or face crop changes', async () => {
    const detail = freshDetail();
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: await sharp({ create: { width: 400, height: 200, channels: 3, background: 'white' } }).png().toBuffer() } as Awaited<ReturnType<typeof readCatalogFile>>);
    await catalogPlacementPreview(detail);
    detail.assetVersionId = randomUUID();
    await catalogPlacementPreview(detail);
    detail.thumbnailUrl = `/api/catalog/files/${randomUUID()}`;
    await catalogPlacementPreview(detail);
    detail.views[0].crop.width = 0.4;
    await catalogPlacementPreview(detail);
    expect(readCatalogFile).toHaveBeenCalledTimes(4);
  });

});
