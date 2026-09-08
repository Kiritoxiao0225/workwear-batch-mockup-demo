import type { ArtworkFailure, ArtworkProgressEvent, ArtworkStreamEvent } from '@/lib/artwork-progress';
import type { ArtworkPreparationResponse } from '@/lib/task-review-artwork';

export class ArtworkResponseError extends Error {
  constructor(public failure: ArtworkFailure) { super(failure.error); }
}

/** Previews never resolve this promise. Only a complete prepared result can enter saving. */
export async function readArtworkResponse(response: Response, progress: (event: ArtworkProgressEvent) => void): Promise<ArtworkPreparationResponse> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const result = await response.json();
    if (!response.ok || result.error) throw new ArtworkResponseError(result);
    if (result.status !== 'prepared' || !result.draft?.graphic?.sourceUrl) throw new Error('图案处理结果不完整，未执行保存');
    return result;
  }
  if (!response.body) throw new Error('未收到图案进度，未执行保存');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 64 * 1024 * 1024) throw new Error('图案处理结果过大，未执行保存');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0 || (done && pending.length > 0 && (end = pending.length) > 0)) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ArtworkStreamEvent;
        if (event.type === 'error') throw new ArtworkResponseError(event);
        if (event.type === 'complete') {
          if (event.result?.status !== 'prepared' || !event.result.draft?.graphic?.sourceUrl) throw new Error('图案处理结果不完整，未执行保存');
          return event.result;
        }
        if (event.type === 'progress' || event.type === 'preview' || event.type === 'timing') progress(event);
      }
      if (done) break;
    }
    throw new Error('图案进度连接中断，结果尚未确认；请保留当前页面并核对任务记录，勿重复生图。');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
