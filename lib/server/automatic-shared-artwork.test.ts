import { beforeEach, expect, it, vi } from 'vitest';
import { sharedFixture } from '@/lib/testing/shared-artwork-fixture';
import { reconcileAutomaticSharedArtworks } from './automatic-shared-artwork';
import { ProductionRevisionConflictError } from './wps-production-store';

const store = vi.hoisted(() => ({ state: null as unknown, jobs: [] as { unit_id: string }[], analyses: [] as { record_id: string }[], writes: 0, queries: 0, conflict: false }));
vi.mock('./wps-production-store', async original => ({ ...await original<typeof import('./wps-production-store')>(),
  readWpsProductionState: async () => store.state,
  mutateWpsProductionState: async (revision: number, mutation: (s: unknown) => unknown) => {
    if (store.conflict) throw new ProductionRevisionConflictError(revision, revision + 1);
    store.writes++; return store.state = mutation(store.state);
  },
}));
vi.mock('./catalog-database', () => ({ catalogDatabase: () => ({ query: async (sql: string) => {
  store.queries++; return { rows: sql.includes('FROM artwork_jobs') ? store.jobs : store.analyses };
} }) }));
beforeEach(() => {
  const state = sharedFixture(8);
  state.records[0].source.wpsSource = { ...state.records[0].source.wpsSource!, status: '设计中' };
  Object.assign(store, { state, jobs: [], analyses: [], writes: 0, queries: 0, conflict: false });
});
const state = () => store.state as ReturnType<typeof sharedFixture>;
const sources = () => state().records.map(record => record.source);
it('persists once, without further job queries or writes on unchanged discovery', async () => {
  await reconcileAutomaticSharedArtworks(sources());
  expect(state().sharedArtworks?.[0].unitIds).toHaveLength(8);
  await reconcileAutomaticSharedArtworks(sources());
  expect(store.writes).toBe(1); expect(store.queries).toBe(2);
});
it('only migrates live eligible records whose source evidence still matches', async () => {
  const changed = structuredClone(sources()); changed[0].requirementText += '新的要求';
  await reconcileAutomaticSharedArtworks(changed);
  const done = structuredClone(sources()); done[0].wpsSource!.status = '已完成';
  await reconcileAutomaticSharedArtworks(done);
  expect(store.writes).toBe(0); expect(store.queries).toBe(0);
});
it('preserves job recovery and active analysis snapshots', async () => {
  store.jobs = [{ unit_id: 'shared-u4' }];
  await reconcileAutomaticSharedArtworks(sources());
  expect(store.writes).toBe(0);
  store.jobs = []; store.analyses = [{ record_id: sources()[0].recordId }];
  await reconcileAutomaticSharedArtworks(sources());
  expect(store.writes).toBe(0);
});
it('defers a concurrent edit instead of overwriting it or retrying a stale plan', async () => {
  store.conflict = true;
  expect(await reconcileAutomaticSharedArtworks(sources())).toBe(state());
  expect(store.writes).toBe(0);
});
