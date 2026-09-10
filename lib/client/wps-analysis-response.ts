import type { WpsAnalysisFailure, WpsAnalysisProgress, WpsAnalysisResult, WpsAnalysisStreamEvent } from '@/lib/wps-analysis-progress';

export class WpsAnalysisResponseError extends Error {
  readonly status: number;
  constructor(readonly failure: WpsAnalysisFailure) { super(failure.error); this.status = failure.status; }
}
function complete(result: WpsAnalysisResult) {
  if (!Array.isArray(result?.reviews) || !result.reviews.length) throw new Error('未收到完整解析结果，请重试解析');
  return result;
}

/** Progress is informative; only a complete, validated response can enter the save queue. */
export async function readWpsAnalysisResponse(response: Response, progress: (event: WpsAnalysisProgress) => void): Promise<WpsAnalysisResult> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    let body;
    try { body = await response.json(); }
    catch { throw new WpsAnalysisResponseError({ status: response.status, error: `解析服务返回异常（HTTP ${response.status}），请重试解析` }); }
    if (!response.ok || body.error) throw new WpsAnalysisResponseError({ ...body, status: response.status });
    return complete(body);
  }
  if (!response.body) throw new Error('解析连接没有返回内容，请重试解析');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 8 * 1024 * 1024) throw new Error('解析响应过大，请拆分需求后重试');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0 || (done && pending.length > 0 && (end = pending.length) > 0)) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as WpsAnalysisStreamEvent;
        if (event.type === 'error') throw new WpsAnalysisResponseError(event);
        if (event.type === 'complete') return complete(event.result);
        if (event.type === 'stage' || event.type === 'timing') progress(event);
      }
      if (done) break;
    }
    throw new Error('解析连接已中断，未收到完整方案，请重试解析');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
