import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProductionPreview } from './production-preview-queue';

afterEach(() => vi.unstubAllGlobals());

describe('production preview downloads', () => {
  it('keeps only three downloads active, including response bodies', async () => {
    let active = 0, peak = 0;
    const finish: Array<() => void> = [];
    const fetchMock = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      return { ok: true, blob: () => new Promise<Blob>(resolve => finish.push(() => { active--; resolve(new Blob(['image'])); })) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const work = Array.from({ length: 8 }, (_, i) => readProductionPreview(`/preview/${i}`, new AbortController().signal));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(active).toBe(3);
    for (let i = 0; i < 8; i++) {
      await vi.waitFor(() => expect(finish.length).toBeGreaterThan(0));
      finish.shift()!();
    }
    await Promise.all(work);
    expect(peak).toBe(3); expect(active).toBe(0);
  });

  it('drops an aborted queued preview before sending it and continues after a failure', async () => {
    const finish: Array<() => void> = [];
    const fetchMock = vi.fn((url: string) => new Promise(resolve => finish.push(() => resolve({ ok: url !== '/bad', status: 500, blob: async () => new Blob() }))));
    vi.stubGlobal('fetch', fetchMock);
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const paths = ['/first', '/bad', '/third', '/cancelled', '/last'];
    const work = paths.map((url, i) => readProductionPreview(url, controllers[i].signal));
    const results = Promise.allSettled(work);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controllers[3].abort();
    finish.splice(0).forEach(done => done());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    finish.splice(0).forEach(done => done());
    expect((await results).map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/first', '/bad', '/third', '/last']);
  });

  it('does not request previews whose signal was already aborted', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(readProductionPreview('/cancelled', AbortSignal.abort())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
