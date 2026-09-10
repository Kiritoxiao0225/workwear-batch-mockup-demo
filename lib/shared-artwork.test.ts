import { describe, expect, it } from 'vitest';
import { bindSharedArtwork, detachSharedArtwork, sharedArtworkGroups, sharedArtworkSuggestions, sharedArtworkLeader } from './shared-artwork';
import { importTaskReviews, normalizeProductionTextPlan, updateProductionPlan } from './wps-production';
import { taskReviewFixture } from './testing/task-review-fixture';
import { productionActionSnapshot, productionActionAssertion } from './production-artwork-snapshot';
import { sharedFixture } from './testing/shared-artwork-fixture';
import { assertWpsProductionState } from './server/wps-production-store';

describe('shared artwork identity and application scope', () => {
  it('retains one explicit source across eight garments while preserving eight delivery versions', () => {
    const state = sharedFixture(8, true);
    expect(sharedArtworkGroups(state)).toHaveLength(1);
    expect(sharedArtworkGroups(state)[0].unitIds).toHaveLength(8);
    expect(state.mockupVersions).toHaveLength(8);
    expect(sharedArtworkLeader(state, state.units[7]).id).toBe('shared-u1');
    assertWpsProductionState(state);
  });
  it('only suggests old matches, and refuses different layouts or records', () => {
    const state = sharedFixture();
    expect(sharedArtworkGroups(state)).toHaveLength(0);
    expect(sharedArtworkSuggestions(state, state.records[0].source.recordId)[0]).toHaveLength(3);
    const changed = structuredClone(state); changed.units[1].layoutNote = '横版';
    expect(() => bindSharedArtwork(changed, 'shared-u1', ['shared-u2'], 'g')).toThrow('版式不同');
    changed.units[1].sourceRecordId = 'different-customer';
    expect(() => bindSharedArtwork(changed, 'shared-u1', ['shared-u2'], 'g')).toThrow('同一订单');
  });
  it('freezes the group and all affected garments while unrelated units can proceed', () => {
    const state = bindSharedArtwork(sharedFixture(), 'shared-u1', ['shared-u2'], 'g');
    const action = { action: 'submitArtwork', unitId: 'shared-u1' };
    const guard = productionActionAssertion({ ...action, ...productionActionSnapshot(state, action) })!;
    guard(updateProductionPlan(state, 'shared-u3', { placement: { ...state.units[2].placement!, rotation: 15 } }));
    expect(() => guard(updateProductionPlan(state, 'shared-u2', { placement: { ...state.units[1].placement!, rotation: 15 } }))).toThrow('共用');
    expect(() => guard(detachSharedArtwork(state, 'shared-u2'))).toThrow('共用');
  });
  it('keeps position changes linked and detaches a different content requirement', () => {
    const state = sharedFixture(3, true);
    const moved = updateProductionPlan(state, 'shared-u2', { placement: { ...state.units[1].placement!, widthCm: 12 } });
    expect(moved.units[1].sharedArtworkId).toBe(state.units[1].sharedArtworkId);
    expect(moved.units[0].placement).toEqual(state.units[0].placement);
    const edited = updateProductionPlan(moved, 'shared-u2', { exactText: '仅当前使用' });
    expect(edited.units[1].sharedArtworkId).toBeUndefined();
    expect(sharedArtworkGroups(edited)[0].unitIds).toEqual(['shared-u1', 'shared-u3']);
    assertWpsProductionState(edited);
  });
  it('does not restore a detached application when its explicit source is imported again', () => {
    let state = sharedFixture(3, true);
    const review = taskReviewFixture()[0];
    review.units = Array.from({ length: 3 }, (_, index) => ({ ...review.units[0], id: `shared-u${index + 1}`,
      garmentLabel: `衣服${index + 1}`, instruction: '图1加文字“poppy手机数码”', sharedArtworkId: `${review.source.recordId}:artwork:a1` }));
    state = detachSharedArtwork(state, 'shared-u2');
    const restored = importTaskReviews(state, [review]);
    expect(restored.units[1].sharedArtworkId).toBeUndefined();
    expect(restored.units[1].sharedArtworkDetached).toBe(true);
  });
  it('normalizes legacy pure text as one group without detaching its applications', () => {
    const state = sharedFixture(3, true);
    state.units = state.units.map(unit => ({ ...unit, materialId: null, referenceMaterialIds: [], route: 'auto', generationPrompt: '旧提示词', instruction: '仅排版文字' }));
    const next = normalizeProductionTextPlan(state, 'shared-u1');
    expect(next.units.every(unit => unit.route === 'deterministic' && unit.sharedArtworkId === state.units[0].sharedArtworkId)).toBe(true);
    expect(next.revision).toBe(state.revision + 1);
  });
});
