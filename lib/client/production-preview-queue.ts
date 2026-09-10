import { ArtworkWorkQueue } from '@/lib/artwork-work-queue';
import { assertApiResponse } from './api-response';

// Previews share a page-wide cap; requirement analysis uses its own queue.
const previews = new ArtworkWorkQueue(3);

export async function readProductionPreview(url: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => { previews.cancel(id); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await previews.run(id, async () => {
      signal.throwIfAborted();
      let response: Response;
      try { response = await fetch(url, { signal }); }
      catch {
        signal.throwIfAborted();
        throw new Error('无法连接预览服务，请检查网络后重新读取。');
      }
      await assertApiResponse(response, '预览读取失败');
      signal.throwIfAborted();
      // Hold the slot until the body finishes downloading, not just the headers.
      try { return await response.blob(); }
      catch {
        signal.throwIfAborted();
        throw new Error('预览图片下载中断，请检查网络后重新读取。');
      }
    });
  } finally { signal.removeEventListener('abort', cancel); }
}
