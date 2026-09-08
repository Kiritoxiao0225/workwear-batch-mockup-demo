import { describe, expect, it, vi } from 'vitest';
import { ArtworkWorkQueue, ArtworkQueueCancelledError, type ArtworkQueueJob } from './artwork-work-queue';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

describe('two artwork workers with a FIFO waiting queue', () => {
  it('overlaps finishing with generation, keeps ownership and caps total in-flight work', async () => {
    let jobs: ArtworkQueueJob[] = [];
    const queue = new ArtworkWorkQueue(1, value => { jobs = value; });
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) => queue.run(String(index), async (progress, finishGeneration) => {
      started.push(index);
      finishGeneration(); finishGeneration();
      progress('正在保存');
      await gate.promise;
    }).catch(error => error));
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    expect(jobs.map(job => job.status)).toEqual(['finishing', 'finishing', 'queued']);
    expect(queue.cancel('0')).toBe(false);
    await expect(queue.run('0', async () => {})).rejects.toThrow('已在制作队列');
    gates[0].reject(new Error('save failed')); await runs[0];
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[1].resolve(); gates[2].resolve(); await Promise.all(runs);
    expect(queue.size).toBe(0);
    // Earlier double-release/failure must not leave the counters below zero.
    const next = deferred();
    const run = queue.run('next', () => next.promise);
    const last = vi.fn(async () => {});
    const lastRun = queue.run('last', last);
    await Promise.resolve(); expect(last).not.toHaveBeenCalled();
    next.resolve(); await run; await lastRun;
  });
  it('runs two jobs, starts the third as soon as either finishes, and preserves separate progress', async () => {
    let jobs: ArtworkQueueJob[] = [];
    const queue = new ArtworkWorkQueue(2, value => { jobs = value; });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let active = 0, peak = 0;
    const runs = gates.map((gate, index) => queue.run(String(index), async progress => {
      active++; peak = Math.max(peak, active); started.push(index);
      progress(`制作 ${index}`);
      await gate.promise;
      active--;
      return index;
    }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(jobs.map(job => [job.id, job.status, job.progress])).toEqual([
      ['0', 'running', '制作 0'], ['1', 'running', '制作 1'], ['2', 'queued', '排队等待制作'], ['3', 'queued', '排队等待制作'],
    ]);
    gates[1].resolve(); await runs[1]; await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve(); await runs[0]; await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve(); gates[3].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(jobs).toEqual([]);
    expect(queue.size).toBe(0);
  });

  it('isolates failures without retry, rejects duplicates, and cancels only waiting jobs', async () => {
    const queue = new ArtworkWorkQueue();
    const a = deferred(), b = deferred();
    const runA = queue.run('a', () => a.promise).catch(error => error);
    const runB = queue.run('b', () => b.promise);
    const cancelled = vi.fn(async () => {}), remaining = vi.fn(async () => 'saved');
    const runC = queue.run('c', cancelled).catch(error => error);
    const runD = queue.run('d', remaining);
    await expect(queue.run('a', cancelled)).rejects.toThrow('已在制作队列');
    expect(queue.cancel('a')).toBe(false);
    expect(queue.cancel('c')).toBe(true);
    expect(await runC).toBeInstanceOf(ArtworkQueueCancelledError);
    a.reject(new Error('provider 429'));
    expect((await runA).message).toBe('provider 429');
    expect(await runD).toBe('saved');
    expect(remaining).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    b.resolve(); await runB;
    expect(queue.size).toBe(0);
  });
});
