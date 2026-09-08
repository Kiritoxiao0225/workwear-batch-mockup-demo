import { describe, expect, it } from 'vitest';
import { clearLegacyArtworkResults, emptyWpsProductionState, importTaskReviews, type ArtworkValidation } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';

function fixture() {
  const state = importTaskReviews(emptyWpsProductionState(), taskReviewFixture());
  const first = state.units[0], last = state.units.at(-1)!;
  first.artwork = { url: '/uploads/logos/old.png', name: 'old.png', recipeFingerprint: first.recipeFingerprint, createdAt: '2026-09-05T00:00:00Z', validation: { sha256: 'old' } as ArtworkValidation };
  first.gateA = first.gateB = { actor: 'operator', confirmedAt: '2026-09-05T00:00:00Z', fingerprint: 'old' };
  last.artwork = { ...first.artwork, url: '/uploads/logos/new.png', validation: { sha256: 'new', quality: artworkQualityFixture('new') } as ArtworkValidation };
  const version = state.mockupVersions.find(version => version.unitIds.includes(first.id))!;
  version.finalConfirmation = first.gateB;
  version.output = { url: '/uploads/mockups/old.png' } as NonNullable<typeof version.output>;
  return { state, first, last, version };
}
describe('scoped legacy artwork cleanup', () => {
  it('clears old outputs and confirmations while preserving task inputs and new results', () => {
    const { state, first, last, version } = fixture();
    const result = clearLegacyArtworkResults(state, [{ unitId: first.id, sha256: 'old' }]);
    expect(result.revision).toBe(state.revision + 1);
    const cleared = result.units.find(unit => unit.id === first.id)!;
    expect(cleared).toMatchObject({ artwork: null, gateA: null, gateB: null, attempts: [], error: null });
    for (const key of ['materialId', 'referenceMaterialIds', 'garment', 'placement', 'instruction', 'exactText', 'recipeFingerprint', 'planFingerprint'] as const) expect(cleared[key]).toEqual(first[key]);
    expect(result.units.find(unit => unit.id === last.id)).toEqual(last);
    expect(result.records).toEqual(state.records);
    expect(result.mockupVersions.find(item => item.id === version.id)).toMatchObject({ output: null, finalConfirmation: null, status: 'waitingArtwork' });
    expect(first.artwork).not.toBeNull();
  });
  it('refuses changed files, new-flow results and unfinished calls atomically', () => {
    const { state, first, last } = fixture();
    expect(() => clearLegacyArtworkResults(state, [{ unitId: first.id, sha256: 'changed' }])).toThrow('图案已变化');
    expect(() => clearLegacyArtworkResults(state, [{ unitId: first.id, sha256: 'old' }, { unitId: last.id, sha256: 'new' }])).toThrow('不能清理新流程');
    first.attempts = [{ status: 'processing' }] as typeof first.attempts;
    expect(() => clearLegacyArtworkResults(state, [{ unitId: first.id, sha256: 'old' }])).toThrow('未完成');
    expect(first.artwork).not.toBeNull();
  });
});
