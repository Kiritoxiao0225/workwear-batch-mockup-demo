import { afterEach, expect, it, vi } from 'vitest';
import { ArtworkJobsSubmissionUnknownError, submitArtworkJobs } from './artwork-jobs-response';

afterEach(() => { vi.unstubAllGlobals(); });
const request = { action: 'enqueue', units: [{ unitId: 'unit-1', snapshot: 'snapshot' }] };
const receipt = { enabled: true, workerOnline: true, jobs: [], results: [{ unitId: 'unit-1', id: 'job-1' }] };

it('waits for an enqueue receipt without sending another request', async () => {
  let respond!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const accepted = vi.fn();
  const pending = submitArtworkJobs(request).then(accepted);
  await Promise.resolve();
  expect(accepted).not.toHaveBeenCalled();
  respond(Response.json(receipt, { status: 202 }));
  await pending;
  expect(accepted).toHaveBeenCalledWith(receipt);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  new DOMException('signal timed out', 'TimeoutError'),
  new TypeError('Failed to fetch'),
])('treats a lost connection as unknown instead of automatically resubmitting', async error => {
  const fetcher = vi.fn().mockRejectedValue(error);
  vi.stubGlobal('fetch', fetcher);
  await expect(submitArtworkJobs(request)).rejects.toBeInstanceOf(ArtworkJobsSubmissionUnknownError);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('explains a non-JSON gateway timeout without leaking HTML or a JSON parser error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>gateway timeout</html>', { status: 504 })));
  await expect(submitArtworkJobs(request)).rejects.toThrow('提交服务返回异常：服务器响应超时（HTTP 504），暂时无法确认是否已加入后台队列');
});

it('preserves a definite rejection and the server reason', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: '这张图案的要求已变化' }, { status: 409 })));
  const error = await submitArtworkJobs(request).catch(error => error);
  expect(error).not.toBeInstanceOf(ArtworkJobsSubmissionUnknownError);
  expect(error.message).toBe('这张图案的要求已变化');
});

it('withholds success for an incomplete receipt', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ results: [] }, { status: 202 })));
  await expect(submitArtworkJobs(request)).rejects.toThrow('未收到完整的提交回执');
});

it('treats a server failure after enqueue as unknown', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: '读取队列失败' }, { status: 500 })));
  const error = await submitArtworkJobs(request).catch(error => error);
  expect(error).toBeInstanceOf(ArtworkJobsSubmissionUnknownError);
  expect(error.message).toContain('读取队列失败');
});
