import { expect, it, vi } from 'vitest';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import type { ArtworkPreparationResponse } from '@/lib/task-review-artwork';
import type { ArtworkStreamEvent } from '@/lib/artwork-progress';
import { ArtworkResponseError, readArtworkResponse } from './artwork-response';

const result = { status: 'prepared', draft: createLegacyArtworkDraft('/api/production-files/finished') } as ArtworkPreparationResponse;
const encode = (event: ArtworkStreamEvent) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
it('handles UTF-8 split at every byte and resolves only the final prepared result', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const events = vi.fn();
  const saved = vi.fn();
  const pending = readArtworkResponse(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }), events).then(saved);
  for (const byte of encode({ type: 'preview', url: 'data:image/png;base64,AAAA', label: '候选预览 · 尚未保存' })) controller.enqueue(Uint8Array.of(byte));
  await vi.waitFor(() => expect(events).toHaveBeenCalledOnce());
  expect(events.mock.calls[0][0].label).toBe('候选预览 · 尚未保存');
  expect(saved).not.toHaveBeenCalled();
  controller.enqueue(encode({ type: 'complete', result }));
  controller.close(); await pending;
  expect(saved).toHaveBeenCalledExactlyOnceWith(result);
});

it('retains cutout/candidate errors and rejects an interrupted preview without returning a draft', async () => {
  const candidate = { runId: 'id', url: 'original', model: 'test', reason: 'cutout failed', promptHash: 'hash' };
  const response = new Response(encode({ type: 'error', status: 422, error: candidate.reason, candidate }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const error = await readArtworkResponse(response, () => {}).catch(error => error);
  expect(error).toBeInstanceOf(ArtworkResponseError);
  expect(error.failure.candidate).toEqual(candidate);
  await expect(readArtworkResponse(new Response(encode({ type: 'preview', url: 'original', label: '未保存' }), { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {})).rejects.toThrow('连接中断');
});

it('supports the existing JSON contract and rejects malformed completed frames', async () => {
  expect(await readArtworkResponse(Response.json(result), () => {})).toEqual(result);
  await expect(readArtworkResponse(Response.json({ error: '请先整理生图提示词' }, { status: 400 }), () => {})).rejects.toThrow('请先整理');
  await expect(readArtworkResponse(new Response('{"type":"complete","result":{"status":"prepared"}}\n', { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {})).rejects.toThrow('不完整');
});

it('reports gateway and malformed progress failures without a false prepared result', async () => {
  await expect(readArtworkResponse(new Response('<html>bad gateway</html>', { status: 502 }), () => {})).rejects.toThrow('HTTP 502');
  await expect(readArtworkResponse(new Response('{broken}\n', { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {})).rejects.toThrow('图案进度响应格式不正确');
});
