import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ARTWORK_INSPECTION_BUDGET_MS, retryArtworkInspection } from './artwork-inspection-retry';

const disconnected = () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.spyOn(Math, 'random').mockReturnValue(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('retries only the failed inspection after a backoff and returns its actual attempt count', async () => {
  const work = vi.fn().mockRejectedValueOnce(disconnected()).mockResolvedValue({ checks: ['passed'] });
  const onRetry = vi.fn();
  const result = retryArtworkInspection(work, { onRetry });
  await vi.advanceTimersByTimeAsync(1999);
  expect(work).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ value: { checks: ['passed'] }, attempts: 2 });
  expect(onRetry).toHaveBeenCalledWith({ attempt: 2, maxAttempts: 3, delayMs: 2000 });
  expect(work.mock.calls).toEqual([[120_000], [120_000]]);
});

it('stops after three transient failures and preserves the transport cause', async () => {
  const error = disconnected(), work = vi.fn().mockRejectedValue(error);
  const result = retryArtworkInspection(work).catch(failure => failure);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ inspectionAttempts: 3, cause: error });
  expect(work).toHaveBeenCalledTimes(3);
  expect(Date.now()).toBe(7000);
});

it('caps the second timeout by the remaining overall budget instead of waiting 120 seconds each time', async () => {
  const timeouts: number[] = [];
  const result = retryArtworkInspection(async timeoutMs => {
    timeouts.push(timeoutMs);
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    throw new DOMException('deadline', 'TimeoutError');
  }).catch(failure => failure);
  await vi.runAllTimersAsync();
  expect(timeouts).toEqual([120_000, 58_000]);
  expect(await result).toMatchObject({ inspectionAttempts: 2 });
  expect(Date.now()).toBe(ARTWORK_INSPECTION_BUDGET_MS);
});

it.each([429, 503])('respects HTTP %s Retry-After without changing the request', async httpStatus => {
  const work = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { httpStatus, retryAfterMs: 15_000 })).mockResolvedValue('ok');
  const result = retryArtworkInspection(work);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(work).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ value: 'ok', attempts: 2 });
});

it('does not retry a server delay beyond the budget', async () => {
  const work = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { httpStatus: 429, retryAfterMs: 181_000 }));
  await expect(retryArtworkInspection(work)).rejects.toMatchObject({ inspectionAttempts: 1 });
  expect(work).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  Object.assign(new Error('HTTP 401'), { httpStatus: 401 }),
  Object.assign(new Error('HTTP 403'), { httpStatus: 403 }),
  new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
  new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }),
  new SyntaxError('bad JSON'),
  new Error('核对缺少逐项结果'),
  new DOMException('cancelled', 'AbortError'),
])('returns permanent or invalid-result errors without another call: %s', async error => {
  const work = vi.fn().mockRejectedValue(error);
  await expect(retryArtworkInspection(work)).rejects.toBe(error);
  expect(work).toHaveBeenCalledOnce();
});

it.each(['failed', 'uncertain'])('never retries a valid %s verdict to try to obtain a pass', async status => {
  const verdict = { checks: [{ status }] }, work = vi.fn().mockResolvedValue(verdict);
  expect(await retryArtworkInspection(work)).toEqual({ value: verdict, attempts: 1 });
  expect(work).toHaveBeenCalledOnce();
});

it('does not issue a retry if durable ownership was lost during backoff', async () => {
  const work = vi.fn().mockRejectedValue(disconnected());
  const result = retryArtworkInspection(work, { onRetry: () => { throw new Error('job ownership lost'); } }).catch(failure => failure);
  await vi.runAllTimersAsync();
  expect((await result).message).toBe('job ownership lost');
  expect(work).toHaveBeenCalledOnce();
});

it('never starts another request after the budget expires during a retry callback', async () => {
  const work = vi.fn().mockRejectedValue(disconnected());
  const result = retryArtworkInspection(work, { onRetry: () => { vi.setSystemTime(ARTWORK_INSPECTION_BUDGET_MS + 1); } }).catch(failure => failure);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ inspectionAttempts: 1 });
  expect(work).toHaveBeenCalledOnce();
});
