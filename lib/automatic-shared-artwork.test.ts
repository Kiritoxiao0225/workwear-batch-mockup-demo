import { describe, expect, it } from 'vitest';
import { autoLinkSharedArtworks, detachSharedArtwork, sharedArtworkGroups } from './shared-artwork';
import { sharedFixture } from './testing/shared-artwork-fixture';
import { emptyWpsProductionState, importTaskReviews, upsertTaskReviews } from './wps-production';
import { taskReviewFixture } from './testing/task-review-fixture';
import { assertWpsProductionState } from './server/wps-production-store';

describe('automatic shared artwork', () => {
  it('links eight colors without changing their eight delivery versions, placements or confirmations; repeat is a no-op', () => {
    const initial = sharedFixture(8);
    initial.units.forEach((unit, index) => { unit.placement = { ...unit.placement!, widthCm: index + 5 }; });
    const next = autoLinkSharedArtworks(initial);
    expect(sharedArtworkGroups(next)).toHaveLength(1);
    expect(next.sharedArtworks![0]).toMatchObject({ automatic: true, versions: [], unitIds: initial.units.map(unit => unit.id) });
    expect(next.mockupVersions).toEqual(initial.mockupVersions);
    expect(next.units.map(unit => [unit.placement, unit.gateA, unit.gateB, unit.attempts, unit.artwork])).toEqual(initial.units.map(unit => [unit.placement, unit.gateA, unit.gateB, unit.attempts, unit.artwork]));
    expect(next.revision).toBe(initial.revision + 1);
    expect(autoLinkSharedArtworks(next)).toBe(next);
    assertWpsProductionState(next);
  });
  it.each(['instruction', 'generationPrompt', 'exactText', 'layoutNote', 'materialId', 'sourceRecordId', 'variantLabel'] as const)('does not merge a different %s', field => {
    const state = sharedFixture(2); state.units[1][field] = 'different';
    expect(autoLinkSharedArtworks(state)).toBe(state);
  });
  it('keeps separate locations, reference order, source scope and processing choices', () => {
    for (const patch of [{ placement: { ...sharedFixture(2).units[0].placement!, key: 'back' as const } },
      { referenceMaterialIds: ['ref'] }, { sourceScope: 'full' as const }, { artworkMethod: 'generate' as const },
      { ambiguities: ['待核对文字'] }]) {
      const state = sharedFixture(2); Object.assign(state.units[1], patch);
      expect(autoLinkSharedArtworks(state)).toBe(state);
    }
  });
  it('preserves existing drafts, previous drafts, attempts, fixed versions and manual detach', () => {
    for (const field of ['artwork', 'previousArtwork', 'gateB', 'sharedArtworkDetached', 'returnReason', 'error'] as const) {
      const state = sharedFixture(2); Object.assign(state.units[1], { [field]: true });
      expect(autoLinkSharedArtworks(state)).toBe(state);
    }
    const state = sharedFixture(2); state.units[1].attempts = [{} as never];
    expect(autoLinkSharedArtworks(state)).toBe(state);
    state.units[1].attempts = []; state.mockupVersions[1].finalConfirmation = { actor: 'operator', fingerprint: 'fixed', confirmedAt: new Date().toISOString() };
    expect(autoLinkSharedArtworks(state)).toBe(state);
    const detached = detachSharedArtwork(autoLinkSharedArtworks(sharedFixture(3)), 'shared-u2');
    expect(autoLinkSharedArtworks(detached)).toBe(detached);
    expect(detached.units[1].sharedArtworkDetached).toBe(true);
  });
  it('skips the whole candidate while any member has a queued job and only processes scoped records', () => {
    const state = sharedFixture(8);
    expect(autoLinkSharedArtworks(state, { blockedUnitIds: new Set(['shared-u4']) })).toBe(state);
    expect(autoLinkSharedArtworks(state, { recordIds: new Set(['other']) })).toBe(state);
    expect(autoLinkSharedArtworks(state, { blockedUnitIds: new Set(['other']) }).sharedArtworks).toHaveLength(1);
  });
  it('persists automatic groups from both import and analysis upsert with one revision; reimport respects detach', () => {
    const review = taskReviewFixture()[0];
    review.units = Array.from({ length: 3 }, (_, index) => ({ ...structuredClone(review.units[0]), id: `auto-u${index}`, garmentLabel: `衣服${index}` }));
    for (const save of [importTaskReviews, upsertTaskReviews]) {
      const state = save(emptyWpsProductionState(), [review]);
      expect(state.revision).toBe(1);
      expect(state.sharedArtworks![0].unitIds).toHaveLength(3);
      const next = save(detachSharedArtwork(state, 'auto-u1'), [review]);
      expect(next.units[1].sharedArtworkId).toBeUndefined();
      expect(next.units[1].sharedArtworkDetached).toBe(true);
      assertWpsProductionState(next);
    }
  });
});
