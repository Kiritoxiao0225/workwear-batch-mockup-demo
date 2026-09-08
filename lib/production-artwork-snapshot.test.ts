import { describe, expect, it } from 'vitest';
import { productionActionSnapshot, productionActionAssertion, productionArtworkSnapshot, assertProductionArtworkSnapshot } from './production-artwork-snapshot';
import { emptyWpsProductionState, importTaskReviews, updateProductionPlan } from './wps-production';
import { taskReviewFixture } from './testing/task-review-fixture';
import { garmentFixture } from './testing/production-garment-fixture';

const reordered = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).reverse()) : entry));
const fixture = () => {
  const reviews = taskReviewFixture();
  reviews.forEach(review => review.units.forEach(unit => { unit.garment = garmentFixture(); }));
  return importTaskReviews(emptyWpsProductionState(), reviews);
};
describe('snapshot comparison after JSON database persistence', () => {
  it('accepts identical version and nested unit content despite jsonb key order', () => {
    const state = fixture(), action = { action: 'savePlacements', updates: [{ unitId: state.units[0].id }] };
    const snapshot = productionActionSnapshot(state, action);
    expect(snapshot).not.toEqual(productionActionSnapshot(reordered(state), action));
    expect(() => productionActionAssertion({ ...action, ...snapshot })!(reordered(state))).not.toThrow();
  });
  it('accepts equivalent single-unit snapshots, including the artwork-save guard', () => {
    const state = fixture(), unit = state.units[0];
    const source = state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source;
    expect(() => assertProductionArtworkSnapshot(reordered(state), unit.id, productionArtworkSnapshot(unit, source))).not.toThrow();
  });
  it('still rejects changed placement values and malformed snapshots', () => {
    const state = fixture(), action = { action: 'savePlacements', updates: [{ unitId: state.units[0].id }] };
    const snapshot = productionActionSnapshot(state, action);
    const changed = updateProductionPlan(reordered(state), state.units[0].id, { placement: { ...state.units[0].placement!, rotation: 10 } });
    expect(() => productionActionAssertion({ ...action, ...snapshot })!(changed)).toThrow('已变化');
    expect(() => productionActionAssertion({ ...action, expectedVersionSnapshot: '{bad' })!(state)).toThrow('已变化');
  });
});
