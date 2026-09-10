import type { ArtworkJobsResponse } from '@/lib/artwork-jobs';
import { apiResponseError, readApiPayload } from './api-response';

export type ArtworkJobsSubmission = ArtworkJobsResponse & { results?: { unitId: string; error?: string }[] };

export class ArtworkJobsSubmissionUnknownError extends Error {
  constructor(reason: string) {
    super(`${reason}，暂时无法确认是否已加入后台队列。正在重新查询队列，请先查看本行进度，不要连续点击制作。`);
  }
}

/** A missing response does not prove the enqueue failed. Never resubmit here. */
export async function submitArtworkJobs(body: unknown): Promise<ArtworkJobsSubmission> {
  let response: Response;
  try {
    response = await fetch('/api/wps-production/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new ArtworkJobsSubmissionUnknownError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
      ? '提交等待超时' : '提交连接中断');
  }
  let payload;
  try { payload = await readApiPayload(response, '提交服务返回异常'); }
  catch (error) { throw new ArtworkJobsSubmissionUnknownError(error instanceof Error ? error.message : String(error)); }
  if (!response.ok) {
    const error = apiResponseError(response, payload, '提交后台制作任务失败');
    if (response.status >= 500) throw new ArtworkJobsSubmissionUnknownError(error.message);
    throw error;
  }
  if (!payload || typeof payload.enabled !== 'boolean' || !Array.isArray(payload.jobs)) {
    throw new ArtworkJobsSubmissionUnknownError('未收到完整的提交回执');
  }
  return payload;
}
