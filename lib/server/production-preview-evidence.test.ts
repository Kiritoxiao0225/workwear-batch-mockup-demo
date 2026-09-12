import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { taskBFixture } from '@/lib/testing/task-b-fixture';
import { readCatalogFile } from './catalog-files';
import { readConfirmedBodyScales } from './catalog-body-calibration';
import { preflightResolvedArtworkUnit } from './artwork-preflight';
import { prepareProductionPreviewUnit } from './production-preview-readiness';

vi.mock('./catalog-files', () => ({ readCatalogFile: vi.fn(), fileSha256: (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex') }));
vi.mock('./catalog-body-calibration', async original => ({ ...await original<typeof import('./catalog-body-calibration')>(), readConfirmedBodyScales: vi.fn() }));
vi.mock('./catalog-database', () => ({ catalogDatabase: () => { throw new Error('Synthetic test must not access PostgreSQL'); } }));
vi.mock('./wps-analysis-save', () => ({ verifyWpsAnalysisSources: vi.fn(() => { throw new Error('No live WPS allowed'); }) }));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('CATALOG_DATABASE_URL', ''); vi.mocked(readConfirmedBodyScales).mockResolvedValue(new Map()); });
afterEach(() => { vi.unstubAllEnvs(); });
const outline = '<svg width="400" height="500"><path fill="black" d="M155 25H245L380 100V170H310V475H90V170H20V100Z"/></svg>';
async function synthetic(opaque = false) {
  const fixture = taskBFixture();
  const bytes = opaque ? await sharp({ create: { width: 400, height: 500, channels: 3, background: 'white' } }).png().toBuffer()
    : await sharp(Buffer.from(outline)).png().toBuffer();
  const garment = fixture.unit.garment!;
  garment.width = 400; garment.height = 500;
  garment.sha256 = createHash('sha256').update(bytes).digest('hex');
  garment.views = [{ ...garment.views[0], standard: null, bodyScale: undefined, crop: { x: 0, y: 0, width: 1, height: 1 } }];
  vi.mocked(readCatalogFile).mockResolvedValue({ bytes } as Awaited<ReturnType<typeof readCatalogFile>>);
  return { ...fixture, bytes };
}
describe('B2 trusted synthetic asset evidence (no standards written)', () => {
  it('recovers only a measurable alpha torso, keeping the exact asset SHA, crop and face', async () => {
    const { state, unit, source, bytes } = await synthetic();
    const before = structuredClone(state), sha = createHash('sha256').update(bytes).digest('hex');
    const check = await preflightResolvedArtworkUnit(unit, source, 'mockup');
    const rendered = await prepareProductionPreviewUnit(unit);
    expect(check.blockers).toEqual([]);
    expect(rendered.garment!.views[0].bodyScale?.widthRatio).toBeCloseTo(.55, 2);
    expect(rendered.garment!.views[0].bodyScale?.basis).toBe('alpha-torso-v1');
    expect(rendered.garment!.views[0].standard).toBeNull();
    expect(rendered.garment!.sha256).toBe(sha);
    expect(rendered.garment!.views[0].crop).toEqual(unit.garment!.views[0].crop);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
    expect(state).toEqual(before);
  });
  it('refuses an opaque photo, never borrowing the previous colour’s successful evidence', async () => {
    await prepareProductionPreviewUnit((await synthetic()).unit);
    const { unit, source } = await synthetic(true);
    expect((await preflightResolvedArtworkUnit(unit, source, 'artwork')).blockers).toEqual([]);
    expect((await preflightResolvedArtworkUnit(unit, source, 'mockup')).garmentIssue).toContain('衣身宽度');
    await expect(prepareProductionPreviewUnit(unit)).rejects.toThrow('衣身宽度');
    expect(unit.artwork).not.toBeNull();
    expect(unit.garment!.views[0].bodyScale).toBeUndefined();
  });
  it('does not accept mismatched original bytes or fall back to an unmeasured back face', async () => {
    const { unit, source } = await synthetic();
    unit.garment!.sha256 = 'c'.repeat(64);
    const check = await preflightResolvedArtworkUnit(unit, source, 'mockup');
    expect(check.blockers.join(' ')).toContain('底图内容已变化');
    unit.placement!.key = 'back';
    await expect(prepareProductionPreviewUnit(unit, { fixed: true })).rejects.toThrow('背面');
    const url = new URL((await preflightResolvedArtworkUnit(unit, source, 'artwork')).calibrationUrl, 'http://local.test');
    expect(url.searchParams.get('face')).toBe('back');
  });
});
