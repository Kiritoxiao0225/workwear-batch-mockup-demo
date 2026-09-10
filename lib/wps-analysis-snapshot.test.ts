import { expect, it } from 'vitest';
import { sharedFixture } from './testing/shared-artwork-fixture';
import { assertWpsAnalysisSnapshot, wpsAnalysisSnapshot } from './wps-analysis-snapshot';

it('rejects late analysis after manual edits, shared membership or final confirmation changes', () => {
  const state = sharedFixture(3, true), id = state.records[0].source.recordId;
  const snapshot = wpsAnalysisSnapshot(state, id);
  for (const change of [
    (next: typeof state) => { next.units[0].routeEvidence = '人工已修改'; },
    (next: typeof state) => { next.sharedArtworks![0].unitIds.pop(); },
    (next: typeof state) => { next.mockupVersions[0].status = 'approved'; },
  ]) {
    const next = structuredClone(state); change(next);
    expect(() => assertWpsAnalysisSnapshot(next, id, snapshot)).toThrow('未覆盖');
  }
});
it('allows unrelated revisions and stable JSONB object ordering, while detecting changed source', () => {
  const state = sharedFixture(), id = state.records[0].source.recordId, snapshot = wpsAnalysisSnapshot(state, id);
  const reordered = JSON.parse(JSON.stringify(state, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
  reordered.revision++; reordered.updatedAt = new Date().toISOString();
  expect(() => assertWpsAnalysisSnapshot(reordered, id, snapshot)).not.toThrow();
  reordered.records[0].source.requirementText += '新要求';
  expect(() => assertWpsAnalysisSnapshot(reordered, id, snapshot)).toThrow();
});
