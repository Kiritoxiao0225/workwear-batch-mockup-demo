import { describe, expect, it, vi } from 'vitest';
import { roundWithin, sortBatches } from './listing-jobs';

describe('roundWithin', () => {
  it('leaves a round that never finishes behind so the loop goes on', async () => {
    vi.useFakeTimers();
    const onStuck = vi.fn();
    const waiting = roundWithin(() => new Promise<void>(() => {}), 1000, onStuck);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(onStuck).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('says nothing about a round that finishes in time', async () => {
    const onStuck = vi.fn();
    await roundWithin(async () => {}, 1000, onStuck);
    expect(onStuck).not.toHaveBeenCalled();
  });
});

describe('the analysis in parts', () => {
  const view = (n: number, from = 1) => ({ text: '', dataUrl: '', ids: Array.from({ length: n }, (_, k) => `M${from + k}`) });
  it('cuts the views into batches of about forty images, in order, never splitting a sheet', () => {
    const batches = sortBatches([view(25, 1), view(25, 26), view(10, 51), view(49, 61), view(3, 110)]);
    expect(batches.map(b => b.flatMap(v => v.ids).length)).toEqual([25, 35, 49, 3]);
    expect(batches.flat().flatMap(v => v.ids)).toEqual(Array.from({ length: 112 }, (_, k) => `M${k + 1}`));
  });
});
