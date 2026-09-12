import { describe, expect, it } from 'vitest';
import { taskBFixture } from './testing/task-b-fixture';
import { garmentFixture } from './testing/production-garment-fixture';
import { initialTaskPlacement, productionPreviewReadiness, productionPreviewFixed, productionPreviewProgress } from './production-preview';
import { garmentPlacementIssue, productionPlacementGeometry } from './production-garment';
import { productionArtworkSnapshot, productionActionSnapshot } from './production-artwork-snapshot';

// These fixtures deliberately have no saved standard; the alpha body width is
// evidence for centimetres, not an implicit human placement or confirmation.
describe('B1/B2 operation-specific read-only readiness', () => {
  it('accepts alpha torso/no standard with the exact renderer candidate and actual content bounds', () => {
    const { state, source, unit } = taskBFixture();
    const before = structuredClone(state), snapshot = productionArtworkSnapshot(unit, source);
    const ready = productionPreviewReadiness(unit);
    expect(garmentPlacementIssue(unit.garment, unit.placement)).toContain('尚未校准');
    expect(ready).toMatchObject({ garmentReady: true, previewReady: true, temporaryPlacement: true });
    expect(ready.placement).toEqual(initialTaskPlacement(unit, unit.artwork!.validation));
    const geometry = productionPlacementGeometry(unit.garment!, ready.placement!, 5);
    expect(geometry.width).toBeCloseTo(45); // 9cm / 55cm * 500px face * .55 torso
    expect(geometry.height).toBeCloseTo(9); // actual visible 400:80, NOT 800:600 canvas
    expect(productionArtworkSnapshot(unit, source)).toEqual(snapshot);
    expect(state).toEqual(before);
    expect(unit.gateA).toBeNull();
    expect(unit.placement!.manual).toBeUndefined();
  });
  it('allows garment prerequisites before artwork, but never invents artwork dimensions', () => {
    const { unit } = taskBFixture(false);
    const ready = productionPreviewReadiness(unit);
    expect(ready).toMatchObject({ garmentReady: true, previewReady: false, temporaryPlacement: true });
    expect(ready.artworkIssue).toContain('尚无已保存图稿');
    expect(ready.placement?.manual).toBeUndefined();
  });
  it('reports real missing torso evidence with an asset-pinned colour/face link', () => {
    const { unit } = taskBFixture();
    unit.garment!.views.forEach(view => { delete view.bodyScale; });
    const before = structuredClone(unit), ready = productionPreviewReadiness(unit);
    expect(ready.garmentIssue).toContain('无法确定衣身宽度');
    expect(ready.previewReady).toBe(false);
    const url = new URL(ready.calibrationUrl, 'http://local.test');
    expect(url.searchParams.get('variantId')).toBe(unit.garment!.variantId);
    expect(url.searchParams.get('assetVersionId')).toBe(unit.garment!.assetVersionId);
    expect(url.searchParams.get('face')).toBe('front');
    expect(unit).toEqual(before);
  });
  it('preserves all manual positioning fields, including legacy centimetre policy', () => {
    const { unit } = taskBFixture();
    unit.garment = garmentFixture();
    unit.placement = { ...unit.placement!, sizePolicy: undefined, sizeMode: 'widthCm', widthCm: 8, rotation: 12,
      manual: { centerX: .51, centerY: .5, width: .12 } };
    const ready = productionPreviewReadiness(unit);
    expect(ready).toMatchObject({ temporaryPlacement: false, previewReady: true });
    expect(ready.placement).toBe(unit.placement);
    expect(productionPlacementGeometry(unit.garment, ready.placement!, 5).width).toBeCloseTo(80); // actual 50cm measured width
  });
  it.each(['gateA', 'final', 'output'] as const)('never invents a position for a protected %s snapshot', protection => {
    const { state, unit, version } = taskBFixture();
    if (protection === 'gateA') unit.gateA = { actor: 'human', confirmedAt: state.updatedAt, fingerprint: unit.planFingerprint };
    else if (protection === 'final') version.finalConfirmation = { actor: 'customer', confirmedAt: state.updatedAt, fingerprint: unit.artwork!.validation.sha256 };
    else version.output = { url: '/uploads/mockups/saved.png' } as NonNullable<typeof version.output>;
    const before = structuredClone(state), action = { action: 'savePlacements', updates: [{ unitId: unit.id }] };
    const snapshot = productionActionSnapshot(state, action);
    const ready = productionPreviewReadiness(unit, { fixed: productionPreviewFixed(unit, state.mockupVersions) });
    expect(ready.temporaryPlacement).toBe(false);
    expect(ready.placement).toBe(unit.placement);
    expect(ready.garmentIssue).toContain('尚未校准');
    expect(productionActionSnapshot(state, action)).toEqual(snapshot);
    expect(state).toEqual(before);
  });
  it('keeps requested width, height, size override and out-of-view rejection', () => {
    const { unit } = taskBFixture();
    unit.placement = { ...unit.placement!, requestedSize: { axis: 'widthCm', valueCm: 10, evidence: '宽10cm', inferredUnit: false } };
    let ready = productionPreviewReadiness(unit);
    expect(productionPlacementGeometry(unit.garment!, ready.placement!, 5).width).toBeCloseTo(50);
    unit.placement.sizeOverride = true;
    unit.placement.sizeMode = 'heightCm'; unit.placement.heightCm = 2;
    ready = productionPreviewReadiness(unit);
    expect(productionPlacementGeometry(unit.garment!, ready.placement!, 5).height).toBeCloseTo(10);
    unit.placement.manual = { centerX: .99, centerY: .01, width: .2 };
    expect(productionPreviewReadiness(unit).garmentIssue).toContain('超出');
  });
  it('does not mix file application with preview completion or failures', () => {
    const { unit } = taskBFixture();
    expect(productionPreviewProgress([unit], false, true)).toBe('1/1 个图案已应用 · 预览失败');
    expect(productionPreviewProgress([unit], false, false)).toContain('预览尚未成功');
    expect(productionPreviewProgress([unit], true, false)).toContain('预览已成功');
    expect(productionPreviewProgress([unit], false, true)).not.toContain('已上衣');
  });
});
