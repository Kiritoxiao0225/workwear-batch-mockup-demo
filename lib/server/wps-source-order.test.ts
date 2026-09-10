import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyWpsProductionState, importTaskReviews, upsertTaskReviews, type WpsProductionState } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { liveWpsProductionState } from '@/lib/wps-source';
import { persistWpsSourceOrder } from './wps-source-order';
import { mutateWpsProductionState, readWpsProductionState } from './wps-production-store';

// Exercise the real persistence queue and revision guards without touching live data.
const disk = vi.hoisted(() => ({ state: '', temporary: new Map<string, string>(), writes: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real,
    readFile: vi.fn(async (...args: Parameters<typeof real.readFile>) => String(args[0]).endsWith('/data/wps-production-state.json') ? disk.state : real.readFile(...args)),
    writeFile: vi.fn(async (...args: Parameters<typeof real.writeFile>) => {
      if (String(args[0]).includes('/data/wps-production-state.json.')) { disk.temporary.set(String(args[0]), String(args[1])); disk.writes++; }
      else return real.writeFile(...args);
    }),
    rename: vi.fn(async (...args: Parameters<typeof real.rename>) => {
      if (String(args[1]).endsWith('/data/wps-production-state.json')) { disk.state = disk.temporary.get(String(args[0]))!; disk.temporary.delete(String(args[0])); }
      else return real.rename(...args);
    }),
  };
});

let initial: WpsProductionState;
const reviews = taskReviewFixture().slice(0, 3);
const sources = reviews.map(review => review.source);
beforeEach(() => {
  initial = importTaskReviews(emptyWpsProductionState(), [reviews[0]]);
  disk.state = JSON.stringify(initial);
  disk.temporary.clear(); disk.writes = 0;
});
const ids = (records: typeof sources) => records.map(record => record.recordId);

describe('persisted WPS discovery order', () => {
  it('survives re-reading storage and ignores analysis completion order or source-row reordering', async () => {
    expect(ids(await persistWpsSourceOrder(sources))).toEqual(ids(sources).reverse());
    const saved = await readWpsProductionState();
    expect(saved.units).toEqual(initial.units);
    await mutateWpsProductionState(saved.revision, state => upsertTaskReviews(state, [reviews[2], reviews[1]]));
    const refreshed = await readWpsProductionState();
    expect(refreshed.sourceRecordOrder).toEqual(ids(sources).reverse());
    const sync = await persistWpsSourceOrder([sources[1], sources[2], sources[0]]);
    expect(ids(sync)).toEqual(refreshed.sourceRecordOrder);
    expect(liveWpsProductionState(refreshed, sync).records.map(record => record.source.recordId)).toEqual(refreshed.sourceRecordOrder);
  });

  it('puts several new tasks first, retaining positions of tasks returning to active status', async () => {
    await persistWpsSourceOrder([sources[0]]);
    expect(ids(await persistWpsSourceOrder(sources))).toEqual(ids(sources).reverse());
    const revision = (await readWpsProductionState()).revision;
    await persistWpsSourceOrder([sources[0]]);
    await persistWpsSourceOrder([]);
    expect(ids(await persistWpsSourceOrder(sources))).toEqual(ids(sources).reverse());
    expect((await readWpsProductionState()).revision).toBe(revision);
    expect(disk.writes).toBe(2);
  });

  it('re-reads after concurrent discoveries without losing either new task or saved work', async () => {
    await persistWpsSourceOrder([sources[0]]);
    await Promise.all([
      persistWpsSourceOrder([sources[0], sources[1]]),
      persistWpsSourceOrder([sources[0], sources[2]]),
    ]);
    const saved = await readWpsProductionState();
    expect(new Set(saved.sourceRecordOrder)).toEqual(new Set(ids(sources)));
    expect(saved.sourceRecordOrder?.at(-1)).toBe(sources[0].recordId);
    expect(saved.units).toEqual(initial.units);
    expect(saved.records).toEqual(initial.records);
  });
});
