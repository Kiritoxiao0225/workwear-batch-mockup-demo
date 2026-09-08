import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { torsoWidthRatio, withGarmentBodyScale, withProductionPreviewGeometry } from './wps-garment-sizing';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews } from '@/lib/wps-production';
import { productionActionAssertion, productionActionSnapshot } from '@/lib/production-artwork-snapshot';
import { readCatalogFile } from './catalog-files';
import type { GarmentBinding } from '@/lib/production-garment';
const crop = { x: 0, y: 0, width: 1, height: 1 };
vi.mock('./catalog-files', () => ({ readCatalogFile: vi.fn(), fileSha256: vi.fn() }));
describe('garment body scale evidence', () => {
  it('prepares legacy task geometry without changing saved snapshots or hiding a failed garment', async () => {
    const state = importTaskReviews(emptyWpsProductionState(), taskReviewFixture());
    const garment: GarmentBinding = garmentFixture();
    garment.views.forEach(view => { delete view.bodyScale; });
    state.units[0].garment = garment;
    const broken = structuredClone(garment);
    broken.sha256 = 'b'.repeat(64);
    broken.views.forEach(view => { view.standard = null; });
    state.units[1].garment = broken;
    vi.mocked(readCatalogFile).mockRejectedValueOnce(new Error('asset unavailable'));
    const prepared = await withProductionPreviewGeometry(state);
    expect(prepared.units[0].garment!.views.every(view => view.bodyScale?.basis === 'confirmed-armpits')).toBe(true);
    expect(prepared.units[1]).toBe(state.units[1]);
    expect(state.units[0].garment.views.every(view => !view.bodyScale)).toBe(true);
    expect(prepared.mockupVersions).toBe(state.mockupVersions);
    const action = { action: 'savePlacements', updates: [{ unitId: state.units[0].id }] };
    expect(() => productionActionAssertion({ ...action, ...productionActionSnapshot(prepared, action) })!(state)).not.toThrow();
  });
  it('excludes whitespace and separated long sleeves from the torso width', async () => {
    const bytes = await sharp(Buffer.from('<svg width="1000" height="1000"><path fill="black" d="M380 50H620L960 200V850H840V320H780V950H220V320H160V850H40V200Z"/></svg>')).png().toBuffer();
    expect(await torsoWidthRatio(bytes, crop)).toBeCloseTo(.56, 2);
    const padded = await sharp(bytes).extend({ left: 200, right: 200, top: 100, bottom: 100, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    expect((await torsoWidthRatio(padded, crop))! * 1400).toBeCloseTo((await torsoWidthRatio(bytes, crop))! * 1000, -1);
  });
  it('rejects opaque photos and opaque rectangles on transparent canvases', async () => {
    const opaque = await sharp({ create: { width: 200, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
    expect(await torsoWidthRatio(opaque, crop)).toBeNull();
    const photo = await sharp(opaque).extend({ left: 50, right: 50, top: 50, bottom: 50, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    expect(await torsoWidthRatio(photo, crop)).toBeNull();
  });
  it('uses confirmed armpits in the correct garment frame, without treating 55 as a saved measurement', async () => {
    const garment = garmentFixture();
    garment.views.forEach(view => {
      const spec = view.standard!.specification;
      spec.garmentFrame = { x: .1, y: .1, width: .8, height: .8 };
      spec.measuredWidthCm = null;
      spec.landmarks = [{ key: 'leftArmpit', label: '左腋点', point: { x: .2, y: .4 } }, { key: 'rightArmpit', label: '右腋点', point: { x: .8, y: .4 } }];
    });
    const checked = await withGarmentBodyScale(garment);
    expect(checked.views[0].bodyScale?.basis).toBe('confirmed-armpits');
    expect(checked.views[0].bodyScale?.widthRatio).toBeCloseTo(.48);
    expect(checked.views[0].standard?.specification.measuredWidthCm).toBeNull();
  });
});
