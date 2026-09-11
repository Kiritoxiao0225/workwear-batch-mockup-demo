import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogFixture, garmentFixture } from '@/lib/testing/production-garment-fixture';
import type { GarmentBinding } from '@/lib/production-garment';
import { projectStandard } from '@/lib/catalog';
import { catalogDatabase } from './catalog-database';
import { confirmedArmpitScale, readConfirmedBodyScales } from './catalog-body-calibration';
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));
const query = vi.fn();
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('CATALOG_DATABASE_URL', 'isolated-test'); vi.mocked(catalogDatabase).mockReturnValue({ query }); });
afterEach(() => vi.unstubAllEnvs());
const row = () => ({ id: garmentFixture().views[0].id, face: 'front', crop: garmentFixture().views[0].crop,
  standard_id: catalogFixture().views[0].confirmedId, specification: catalogFixture().views[0].history[0].specification, origin: 'manual' });
it('queries confirmations only for the exact bound image, face and optional historical version', async () => {
  const garment: GarmentBinding = garmentFixture();
  garment.views[0].bodyScale = { basis: 'confirmed-armpits', widthRatio: .55, standardId: row().standard_id! };
  query.mockResolvedValue({ rows: [row()], rowCount: 1 });
  const scales = await readConfirmedBodyScales(garment, [garment.views[0]]);
  expect(scales.get(garment.views[0].id)).toEqual({ widthRatio: .55, basis: 'confirmed-armpits', standardId: row().standard_id });
  const [sql, values] = query.mock.calls[0];
  expect(sql).toContain("p.status='confirmed'");
  expect(sql).toContain('COALESCE(wanted.standard_id,g.confirmed_standard_id)');
  expect(values).toEqual([garment.assetVersionId, garment.variantId, garment.styleId, garment.imageUrl.split('/').at(-1), garment.sha256, garment.width, garment.height,
    [{ view_id: garment.views[0].id, standard_id: row().standard_id }]]);
});
it('projects inherited armpits into the target face rather than using source coordinates', async () => {
  const alignment = { scaleX: .8, scaleY: .9, offsetX: .1, offsetY: .05 }, source = row().specification;
  query.mockResolvedValue({ rows: [{ ...row(), origin: 'inherited', source_specification: source, specification: {}, alignment }], rowCount: 1 });
  const garment = garmentFixture(), scales = await readConfirmedBodyScales(garment, garment.views);
  expect(scales.get(garment.views[0].id)).toEqual(confirmedArmpitScale(projectStandard(source, alignment), row().standard_id!));
  expect(scales.get(garment.views[0].id)?.widthRatio).toBeCloseTo(.44);
});
it.each([{ face: 'back' }, { crop: { x: 0, y: 0, width: .4, height: 1 } }])('rejects mismatched face geometry %j', async mismatch => {
  query.mockResolvedValue({ rows: [{ ...row(), ...mismatch }], rowCount: 1 });
  const garment: GarmentBinding = garmentFixture();
  expect((await readConfirmedBodyScales(garment, garment.views)).size).toBe(0);
});
it('does not cache a missing calibration after it has been confirmed', async () => {
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
  const garment: GarmentBinding = garmentFixture();
  expect((await readConfirmedBodyScales(garment, garment.views)).size).toBe(0);
  expect((await readConfirmedBodyScales(garment, garment.views)).size).toBe(1);
});
it('rejects coincident armpits instead of treating zero as a usable scale', () => {
  const spec = structuredClone(row().specification);
  spec.landmarks[1].point.x = spec.landmarks[0].point.x;
  expect(confirmedArmpitScale(spec)).toBeNull();
});
