import { describe, expect, it, vi } from 'vitest';
import { ArtworkCutoutSessions, CUTOUT_BOOKMARK_KEY } from './artwork-cutout-sessions';
import { emptyWpsProductionState, importTaskReviews, type ProductionArtwork } from '../wps-production';
import { taskReviewFixture } from '../testing/task-review-fixture';
import { productionArtworkSnapshot } from '../production-artwork-snapshot';
import { createLegacyArtworkDraft } from '../artwork-editor';
import type { ArtworkCutoutResult } from '../artwork-cutout';

const originalJob = 'a685cc6a8deeaf28cf82c0ea563e7e6968ae5a79707b51b779e2e3e31e612fc6';
const finalJob = 'f68ea098aae28dae54d6bb01c39a3aa25adac98bef24d9ef23d695e3d6e2f5e8';
const result = (jobKey = originalJob, status: ArtworkCutoutResult['status'] = 'completed'): ArtworkCutoutResult => ({
  status, url: status === 'completed' ? '/api/production-files/cutout' : undefined,
  receipt: { jobKey, route: 'meitu', mode: 'auto', sourceSha256: 'source-sha', sourceUrl: '/api/production-files/source', actualCredits: 1, estimatedCredits: 1, cacheHit: false, reasons: [], version: 'artwork-cutout-v3' },
});
function fixture() {
  const state = importTaskReviews(emptyWpsProductionState(), taskReviewFixture());
  const unit = state.units[0];
  const snapshot = productionArtworkSnapshot(unit, state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source);
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const bookmark = { jobKey: originalJob, snapshot, purpose: 'component' as const, batchId: state.batchId };
  storage.setItem(CUTOUT_BOOKMARK_KEY, JSON.stringify({ [unit.id]: bookmark }));
  const store = new ArtworkCutoutSessions(() => storage);
  store.reconcile(state);
  return { state, unit, snapshot, storage, store, bookmark, saved: () => JSON.parse(storage.getItem(CUTOUT_BOOKMARK_KEY) || '{}') };
}
function completedArtwork() {
  const draft = createLegacyArtworkDraft('/api/production-files/artwork');
  // Actual incident: the first cutout was reused before redraw, the second is the final cutout.
  draft.preprocessing = { ...draft.preprocessing, cutout: result(finalJob).receipt, cutoutRuns: [result().receipt, result(finalJob).receipt] };
  return { url: '/api/production-files/artwork', draft, validation: { sha256: 'saved-sha' } } as ProductionArtwork;
}
function deferred() {
  let resolve!: (value: ArtworkCutoutResult) => void;
  const promise = new Promise<ArtworkCutoutResult>(done => { resolve = done; });
  return { promise, resolve };
}
describe('cutout recovery against saved production receipts', () => {
  it('removes the real incident bookmark on refresh without querying an already-used intermediate step', async () => {
    const f = fixture();
    f.unit.artwork = completedArtwork();
    const query = vi.fn(async () => result());
    f.store.reconcile(f.state);
    await f.store.restore(query);
    expect(query).not.toHaveBeenCalled();
    expect(f.store.getSnapshot()).toEqual({});
    expect(f.saved()).toEqual({});
    expect(f.unit.artwork.draft!.preprocessing.cutoutRuns).toHaveLength(2);
  });
  it('clears both live recovery and browser bookmark after the complete artwork is saved', () => {
    const f = fixture();
    f.store.remember(f.unit.id, result(), f.snapshot, 'component');
    expect(f.store.getSnapshot()[f.unit.id]).toBeDefined();
    f.unit.artwork = completedArtwork();
    f.store.reconcile(f.state);
    expect(f.store.getSnapshot()).toEqual({});
    expect(f.saved()).toEqual({});
  });
  it('also recognizes the primary receipt when older artwork has no cutoutRuns', () => {
    const f = fixture();
    f.unit.artwork = completedArtwork();
    f.unit.artwork.draft!.preprocessing.cutout = result().receipt;
    delete f.unit.artwork.draft!.preprocessing.cutoutRuns;
    f.store.reconcile(f.state);
    expect(f.saved()).toEqual({});
  });
  it('keeps unconsumed results when saving has failed or an unrelated artwork is saved', async () => {
    const f = fixture();
    await f.store.restore(async () => result());
    f.store.reconcile(f.state);
    expect(f.store.getSnapshot()[f.unit.id].stale).toBe(false);
    f.state.units[1].artwork = completedArtwork();
    f.store.reconcile(f.state);
    expect(f.store.getSnapshot()[f.unit.id].result.receipt.jobKey).toBe(originalJob);
    expect(f.saved()[f.unit.id]).toEqual(f.bookmark);
  });
  it.each(['pending', 'unknown'] as const)('retains an unresolved %s job, even when its snapshot changed', async status => {
    const f = fixture();
    f.unit.updatedAt = 'later';
    f.store.reconcile(f.state);
    const query = vi.fn(async () => result(originalJob, status));
    await f.store.restore(query);
    expect(query).toHaveBeenCalledExactlyOnceWith(originalJob);
    expect(f.store.getSnapshot()[f.unit.id]).toMatchObject({ stale: true, result: { status } });
    expect(f.saved()[f.unit.id]).toEqual(f.bookmark);
  });
  it('does not mistake different output from the same source for an already-used job', () => {
    const f = fixture();
    f.unit.artwork = completedArtwork();
    f.store.reconcile(f.state);
    f.store.remember(f.unit.id, result('b'.repeat(64)), f.snapshot, 'recut');
    expect(f.store.getSnapshot()[f.unit.id]).toMatchObject({ purpose: 'recut', stale: true });
    expect(f.saved()[f.unit.id].jobKey).toBe('b'.repeat(64));
  });
  it.each(['save', 'dismiss', 'replace'] as const)('ignores a restoration reply that arrives after %s', async operation => {
    const f = fixture(), pending = deferred();
    const restoring = f.store.restore(() => pending.promise);
    if (operation === 'save') { f.unit.artwork = completedArtwork(); f.store.reconcile(f.state); }
    if (operation === 'dismiss') f.store.discard(f.unit.id);
    if (operation === 'replace') f.store.remember(f.unit.id, result('b'.repeat(64), 'pending'), f.snapshot, 'recut');
    pending.resolve(result());
    await restoring;
    expect(f.store.getSnapshot()[f.unit.id]?.result.receipt.jobKey).toBe(operation === 'replace' ? 'b'.repeat(64) : undefined);
    expect(f.saved()[f.unit.id]?.jobKey).toBe(operation === 'replace' ? 'b'.repeat(64) : undefined);
  });
  it('preserves other batches and ignores replies from a previous batch', async () => {
    const f = fixture(), pending = deferred();
    const restoring = f.store.restore(() => pending.promise);
    const other = { ...f.state, batchId: 'other-batch' };
    f.store.reconcile(other);
    pending.resolve(result());
    await restoring;
    expect(f.store.getSnapshot()).toEqual({});
    expect(f.saved()[f.unit.id]).toEqual(f.bookmark);
  });
  it('does not restore a consumed result from an older production response', () => {
    const f = fixture(), older = structuredClone(f.state);
    f.unit.artwork = completedArtwork();
    f.state.revision++;
    f.store.reconcile(f.state);
    f.store.reconcile(older);
    expect(f.store.remember(f.unit.id, result(), f.snapshot, 'component')).toBe(false);
    expect(f.store.getSnapshot()).toEqual({});
  });
  it('does not query bookmarks for units absent from the current batch', async () => {
    const f = fixture(), query = vi.fn(async () => result());
    f.state.units = f.state.units.filter(unit => unit.id !== f.unit.id);
    f.store.reconcile(f.state);
    await f.store.restore(query);
    expect(query).not.toHaveBeenCalled();
    expect(f.saved()[f.unit.id]).toEqual(f.bookmark);
  });
  it('retains the bookmark when querying fails and does not store image payloads', async () => {
    const f = fixture();
    await f.store.restore(async () => { throw new Error('offline'); });
    expect(f.saved()[f.unit.id]).toEqual(f.bookmark);
    f.store.remember(f.unit.id, result(), f.snapshot, 'generated');
    expect(Object.keys(f.saved()[f.unit.id]).sort()).toEqual(['batchId', 'jobKey', 'purpose', 'snapshot']);
  });
  it('ignores a malformed entry without losing another recoverable task', async () => {
    const f = fixture();
    f.storage.setItem(CUTOUT_BOOKMARK_KEY, JSON.stringify({ ...f.saved(), bad: null }));
    await f.store.restore(async () => result());
    expect(f.store.getSnapshot()[f.unit.id].purpose).toBe('component');
  });
  it('still reconciles live results when browser storage is unavailable', () => {
    const f = fixture();
    const store = new ArtworkCutoutSessions(() => { throw new Error('storage disabled'); });
    store.reconcile(f.state);
    store.remember(f.unit.id, result(), f.snapshot, 'component');
    f.unit.artwork = completedArtwork();
    store.reconcile(f.state);
    expect(store.getSnapshot()).toEqual({});
  });
});
