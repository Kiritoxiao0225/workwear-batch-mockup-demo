import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { downloadArtworkResult } from './artwork-result-download';
const png = () => sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } }).png().toBuffer();
describe('result download recovery without paid submission', () => {
  it('retries truncated and interrupted bodies, then returns the complete original bytes', async () => {
    const bytes = await png();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array(bytes.subarray(0, 30))))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('body disconnected')); } })))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    expect(await downloadArtworkResult('https://example.test/result', '增强图', { fetch: fetcher })).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) { expect(url).toBe('https://example.test/result'); expect(init?.method).toBeUndefined(); }
  });
  it('stops after two extra GET attempts and reports download-only recovery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('read timeout'));
    await expect(downloadArtworkResult('https://example.test/result', '增强图', { fetch: fetcher })).rejects.toThrow('已尝试 3 次，仅重试下载');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not retry expired or unauthorized links or claim the image was saved', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
    await expect(downloadArtworkResult('https://example.test/result', '增强图', { fetch: fetcher })).rejects.toThrow('原服务回执已保留');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
