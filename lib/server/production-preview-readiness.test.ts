import { beforeEach, describe, expect, it, vi } from 'vitest';
import { taskBFixture } from '@/lib/testing/task-b-fixture';
import { sharedFixture } from '@/lib/testing/shared-artwork-fixture';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { productionPreviewFixed, productionPreviewReadiness } from '@/lib/production-preview';
import { GarmentBodyScaleError } from '@/lib/production-sizing';
import { preflightArtworkOperation, preflightResolvedArtworkUnit } from './artwork-preflight';
import { prepareProductionPreviewUnit } from './production-preview-readiness';
import { productionPreviewUnits } from './wps-production-assets';
import { withGarmentBodyScale } from './wps-garment-sizing';

vi.mock('./wps-garment-sizing', async original => ({ ...await original<typeof import('./wps-garment-sizing')>(), withGarmentBodyScale: vi.fn() }));
vi.mock('./wps-analysis-save', () => ({ verifyWpsAnalysisSources: vi.fn(() => { throw new Error('No live WPS allowed in these tests'); }) }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(withGarmentBodyScale).mockImplementation(async garment => structuredClone(garment)); });

describe('B1/B2 real render adapter and operation preflight agree', () => {
  it('uses the same ephemeral placement, does not mutate state or mark it calibrated', async () => {
    const { state, unit, source, version } = taskBFixture();
    const before = structuredClone(state);
    const checked = await preflightResolvedArtworkUnit(unit, source, 'mockup');
    const [rendered] = await productionPreviewUnits([unit], version);
    expect(checked.blockers).toEqual([]);
    expect(rendered.placement).toEqual(checked.placement);
    expect(rendered.placement?.manual).toBeDefined();
    expect(state).toEqual(before);
    expect(unit.garment!.views[0].standard).toBeNull();
  });
  it('rejects missing width before mockup work, but preserves independent artwork capability', async () => {
    const { unit, source } = taskBFixture();
    unit.garment!.views.forEach(view => { delete view.bodyScale; });
    const oldArtwork = structuredClone(unit.artwork);
    expect((await preflightResolvedArtworkUnit(unit, source, 'artwork')).blockers).toEqual([]);
    expect((await preflightResolvedArtworkUnit(unit, source, 'mockup')).blockers.join(' ')).toContain('衣身宽度');
    await expect(prepareProductionPreviewUnit(unit)).rejects.toBeInstanceOf(GarmentBodyScaleError);
    expect(unit.artwork).toEqual(oldArtwork);
  });
  it('artwork absence is a preview blocker, not a made-up geometry or an artwork-generation blocker', async () => {
    const { unit, source } = taskBFixture(false);
    expect((await preflightResolvedArtworkUnit(unit, source, 'mockup')).blockers).toEqual([]);
    const checked = await preflightResolvedArtworkUnit(unit, source, 'preview');
    expect(checked.blockers.join(' ')).toContain('尚无已保存图稿');
    expect(checked.placement?.manual).toBeUndefined();
    await expect(prepareProductionPreviewUnit(unit)).rejects.toThrow('尚无已保存图稿');
  });
  it('recomposes saved pixels even when their old font input is no longer available', async () => {
    const { unit, source } = taskBFixture();
    unit.fontReference = { materialId: 'deleted-font', origin: 'explicit', description: '旧参考字形', evidence: '旧要求' };
    unit.referenceMaterialIds = ['deleted-font'];
    const checked = await preflightResolvedArtworkUnit(unit, source, 'preview');
    expect(checked.blockers).toEqual([]);
    await expect(prepareProductionPreviewUnit(unit)).resolves.toBeDefined();
  });
  it('uses the existing legacy size recovery without changing saved state', async () => {
    const { unit, source, state } = taskBFixture();
    source.requirementText = '左胸宽9，领口往下18cm，文字康悦';
    unit.placement!.requestedSizeIssue = '“左胸宽9”未注明单位，请核对';
    const before = structuredClone(state);
    const checked = await preflightResolvedArtworkUnit(unit, source, 'preview');
    expect(checked.blockers).toEqual([]);
    expect(checked.placement?.requestedSize).toMatchObject({ valueCm: 9, inferredUnit: true });
    expect(state).toEqual(before);
  });
  it('keeps manual positions and frozen versions byte-identical through preparation', async () => {
    const { state, unit, source, version } = taskBFixture();
    unit.placement!.manual = { centerX: .52, centerY: .45, width: .1 };
    version.finalConfirmation = { actor: 'customer', confirmedAt: state.updatedAt, fingerprint: unit.artwork!.validation.sha256 };
    const before = structuredClone(state), fixed = productionPreviewFixed(unit, [version]);
    const checked = await preflightResolvedArtworkUnit(unit, source, 'preview', { fixed });
    const [prepared] = await productionPreviewUnits([unit], version);
    expect(checked.blockers).toEqual([]);
    expect(prepared.placement).toBe(unit.placement);
    expect(withGarmentBodyScale).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });
  it('fails closed for unreadable geometry without blocking independent artwork or swallowing source status', async () => {
    const { unit, source } = taskBFixture();
    vi.mocked(withGarmentBodyScale).mockRejectedValue(new Error('底图内容已变化'));
    const artwork = await preflightResolvedArtworkUnit(unit, source, 'artwork');
    expect(artwork.blockers).toEqual([]);
    expect(artwork.garmentIssue).toContain('底图内容已变化');
    expect((await preflightResolvedArtworkUnit(unit, source, 'mockup')).blockers.join(' ')).toContain('底图内容已变化');
    source.wpsSource = { fileId: 'fixture', sheetId: 1, sheetName: 'fixture', statusFieldName: '任务状态', status: '已完成', statusOptions: [] };
    expect((await preflightResolvedArtworkUnit(unit, source, 'preview')).blockers.join(' ')).toContain('WPS状态');
  });
  it('checks each colour that the shared generation will apply, without rewriting membership or CAS state', async () => {
    const state = sharedFixture(2, true), source = state.records[0].source;
    const base = taskBFixture(false).unit;
    state.units.forEach((unit, index) => {
      Object.assign(unit, { instruction: base.instruction, materialId: null, referenceMaterialIds: [], generationPrompt: undefined,
        exactText: base.exactText, textMode: 'replace', sourceScope: 'subject', route: 'deterministic', ambiguities: [],
        garment: garmentFixture(), placement: structuredClone(base.placement), artwork: null });
      unit.garment!.colorName = index ? '黑色' : '米白';
      unit.garment!.views.forEach(view => { view.standard = null; if (index) delete view.bodyScale; });
    });
    source.requirementText = '两个颜色左胸：康悦';
    const before = structuredClone(state);
    const artwork = await preflightArtworkOperation(state, state.units[0], source, 'artwork');
    const mockup = await preflightArtworkOperation(state, state.units[0], source, 'mockup');
    expect(artwork.blockers).toEqual([]);
    expect(artwork.garmentChecks).toHaveLength(2);
    expect(mockup.blockers.join(' ')).toContain(state.units[1].garmentLabel);
    expect(mockup.calibrationUrl).toContain(state.units[1].garment!.variantId);
    expect(state).toEqual(before);
    expect(productionPreviewReadiness(state.units[0]).garmentReady).toBe(true);
  });
});
