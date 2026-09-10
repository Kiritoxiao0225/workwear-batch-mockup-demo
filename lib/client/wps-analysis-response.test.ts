import { expect, it, vi } from 'vitest';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { readWpsAnalysisResponse, WpsAnalysisResponseError } from './wps-analysis-response';
import type { WpsAnalysisStreamEvent } from '@/lib/wps-analysis-progress';

const result = { reviews: [taskReviewFixture()[0]], model: 'mock' };
const encode = (event: WpsAnalysisStreamEvent) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
const response = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/x-ndjson' } });

it('handles split UTF-8 while withholding partial results from the save queue', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const progress = vi.fn(), save = vi.fn();
  const work = readWpsAnalysisResponse(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }), progress).then(save);
  for (const byte of encode({ type: 'stage', stage: 'model' })) controller.enqueue(Uint8Array.of(byte));
  await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
  expect(save).not.toHaveBeenCalled();
  for (const byte of encode({ type: 'complete', result })) controller.enqueue(Uint8Array.of(byte));
  controller.close(); await work;
  expect(save).toHaveBeenCalledExactlyOnceWith(result);
});

it('preserves stage and trace on failure and rejects an interrupted connection', async () => {
  const failure = { type: 'error' as const, status: 504, error: '模型返回内容超时', stage: 'response' as const, requestId: 'request-1', timings: [{ stage: 'model' as const, durationMs: 180000, status: 'failed' as const }] };
  const error = await readWpsAnalysisResponse(response(encode(failure)), () => {}).catch(error => error);
  expect(error).toBeInstanceOf(WpsAnalysisResponseError); expect(error.failure).toEqual(failure);
  await expect(readWpsAnalysisResponse(response(encode({ type: 'stage', stage: 'model' })), () => {})).rejects.toThrow('连接已中断');
  await expect(readWpsAnalysisResponse(response(encode({ type: 'complete', result: { reviews: [], model: 'mock' } })), () => {})).rejects.toThrow('完整解析结果');
});

it('accepts existing JSON clients and gives a readable gateway failure for non-JSON errors', async () => {
  expect(await readWpsAnalysisResponse(Response.json(result), () => {})).toEqual(result);
  await expect(readWpsAnalysisResponse(Response.json({ error: '原文已经变化' }, { status: 409 }), () => {})).rejects.toThrow('原文已经变化');
  await expect(readWpsAnalysisResponse(new Response('<html>gateway timeout</html>', { status: 504 }), () => {})).rejects.toThrow('HTTP 504');
});
