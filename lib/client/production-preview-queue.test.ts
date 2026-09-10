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

  it.each([
    [500, '无法确定衣身宽度，请在素材库核对左右腋点后更新位置标准'],
    [409, '效果图内容已更新，请读取最新制作状态'],
  ])('preserves the server reason for HTTP %i without retrying', async (status, error) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error }, { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readProductionPreview('/preview', new AbortController().signal)).rejects.toThrow(error);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('explains an HTML gateway timeout instead of displaying markup or a JSON parser error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Gateway Timeout</html>', { status: 504 })));
    await expect(readProductionPreview('/preview', new AbortController().signal)).rejects.toThrow('预览读取失败：服务器响应超时（HTTP 504）');
  });

  it.each([{ error: '  ' }, { error: { detail: 'internal' } }, null])('falls back to the HTTP status when the error payload is unusable: %j', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload, { status: 502 })));
    await expect(readProductionPreview('/preview', new AbortController().signal)).rejects.toThrow('预览读取失败：服务器返回异常（HTTP 502）');
  });

  it('distinguishes a connection failure from a failed image download', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, blob: async () => { throw new TypeError('terminated'); } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(readProductionPreview('/preview', new AbortController().signal)).rejects.toThrow('无法连接预览服务');
    await expect(readProductionPreview('/preview', new AbortController().signal)).rejects.toThrow('预览图片下载中断');
  });
});
