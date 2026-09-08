import { describe, expect, it, vi } from 'vitest';
import { runTaskReviewAnalysisBatch } from './task-review-analysis-batch';

describe('parallel requirements analysis with serialized saves', () => {
  it('starts five orders, saves completion order without revision races, and isolates model/save failures', async () => {
    const replies = new Map<number, { resolve: (value: number) => void; reject: (error: Error) => void }>();
    const saved: number[] = [], failures: number[] = [], completed: number[] = [];
    let saving = false;
    const work = runTaskReviewAnalysisBatch([0, 1, 2, 3, 4, 5, 6], record => new Promise<number>((resolve, reject) => replies.set(record, { resolve, reject })), async result => {
      expect(saving).toBe(false);
      saving = true;
      await new Promise(resolve => setTimeout(resolve, 5));
      saving = false;
      if (result === 3) throw new Error('save conflict');
      saved.push(result);
    }, (record, error) => { completed.push(record); if (error) failures.push(record); });
    expect([...replies.keys()]).toEqual([0, 1, 2, 3, 4]);
    replies.get(2)!.resolve(2); replies.get(1)!.reject(new Error('429')); replies.get(3)!.resolve(3);
    await vi.waitFor(() => expect(replies.size).toBe(7));
    for (const id of [0, 4, 5, 6]) replies.get(id)!.resolve(id);
    await work;
    expect(saved).toEqual([2, 0, 4, 5, 6]);
    expect(failures.sort()).toEqual([1, 3]);
    expect(completed.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
