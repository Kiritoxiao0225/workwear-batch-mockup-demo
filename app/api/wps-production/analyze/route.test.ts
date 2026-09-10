import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SourceTaskRecord } from '@/lib/batch-task-review';
import { sourceTaskSnapshot } from '@/lib/task-review-snapshot';
import { POST } from './route';

const { readWpsRecords, analyzeRecords } = vi.hoisted(() => ({ readWpsRecords: vi.fn(), analyzeRecords: vi.fn() }));
vi.mock('@/lib/server/wps-dbsheet', () => ({ listWpsSourceTaskRecords: readWpsRecords }));
vi.mock('@/lib/server/ark-task-review', () => ({ analyzeSourceTaskRecords: analyzeRecords }));
vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after: vi.fn() }));

function recordWithStatus(status: string): SourceTaskRecord {
  return { ...sourceTaskSnapshot()[0], wpsSource: { fileId: 'file', sheetId: 1, sheetName: '任务', statusFieldName: '状态', status, statusOptions: [] } };
}

function requestFor(records: SourceTaskRecord[]) {
  return new Request('http://localhost/api/wps-production/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  analyzeRecords.mockResolvedValue({ reviews: [], model: 'mock-vision' });
});
afterEach(() => vi.restoreAllMocks());

describe('WPS analysis checks the current source status before calling the model', () => {
  it.each(['🔴待领取', '🟢设计中'])('allows current %s records and uses the independently read source', async (status) => {
    const submitted = recordWithStatus('🔴待领取');
    const current = recordWithStatus(status);
    readWpsRecords.mockResolvedValue({ records: [current] });
    expect((await POST(requestFor([submitted]))).status).toBe(200);
    expect(analyzeRecords).toHaveBeenCalledExactlyOnceWith([current], expect.objectContaining({ signal: expect.any(AbortSignal), trace: expect.any(Object) }));
  });

  it.each(['✔已完成', '⚫已取消', '🔵待完善', '', '未知状态'])('rejects current %s even when the client submits an active status', async (status) => {
    const submitted = recordWithStatus('🟢设计中');
    readWpsRecords.mockResolvedValue({ records: [recordWithStatus(status)] });
    const response = await POST(requestFor([submitted]));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('仅允许分析待领取和设计中');
    expect(analyzeRecords).not.toHaveBeenCalled();
  });

  it('rejects a mixed batch before any model request', async () => {
    const first = recordWithStatus('🔴待领取');
    const second = { ...recordWithStatus('🟢设计中'), recordId: 'second' };
    readWpsRecords.mockResolvedValue({ records: [first, { ...second, wpsSource: { ...second.wpsSource!, status: '⚫已取消' } }] });
    expect((await POST(requestFor([first, second]))).status).toBe(409);
    expect(analyzeRecords).not.toHaveBeenCalled();
  });

  it('rejects missing records and changed requirements before model submission', async () => {
    const submitted = recordWithStatus('🟢设计中');
    readWpsRecords.mockResolvedValueOnce({ records: [] });
    expect((await POST(requestFor([submitted]))).status).toBe(409);
    readWpsRecords.mockResolvedValueOnce({ records: [{ ...submitted, requirementText: '客户已经修改需求' }] });
    const response = await POST(requestFor([submitted]));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('原文或素材已变化');
    expect(analyzeRecords).not.toHaveBeenCalled();
  });

  it('does not call the model when the WPS source cannot be verified', async () => {
    readWpsRecords.mockRejectedValue(new Error('WPS 读取失败'));
    expect((await POST(requestFor([recordWithStatus('🟢设计中')]))).status).toBe(502);
    expect(analyzeRecords).not.toHaveBeenCalled();
  });

  it('reports a provider configuration failure as unavailable after verifying the source', async () => {
    const record = recordWithStatus('🟢设计中');
    readWpsRecords.mockResolvedValue({ records: [record] });
    analyzeRecords.mockRejectedValue(new Error('WPS_ANALYSIS_CONFIG_ERROR: CLIPROXY_API_BASE_URL 必须是包含 /v1 的 HTTPS 地址'));
    const response = await POST(requestFor([record]));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('WPS_ANALYSIS_CONFIG_ERROR:');
  });

  it('streams real stages and completion while retaining source verification', async () => {
    const record = recordWithStatus('🔴待领取');
    readWpsRecords.mockResolvedValue({ records: [record] });
    analyzeRecords.mockImplementation(async (_records, { trace }) => {
      trace.start('model');
      return { reviews: [{ source: record, units: [] }], model: 'mock-vision' };
    });
    const request = requestFor([record]); request.headers.set('accept', 'application/x-ndjson');
    const response = await POST(request);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'stage').map(event => event.stage)).toEqual(['source', 'model']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', result: { model: 'mock-vision' } });
  });

  it('streams a stage-specific timeout without a completed result', async () => {
    const record = recordWithStatus('🔴待领取');
    readWpsRecords.mockResolvedValue({ records: [record] });
    analyzeRecords.mockImplementation(async (_records, { trace }) => { trace.start('model'); throw new DOMException('deadline', 'TimeoutError'); });
    const request = requestFor([record]); request.headers.set('accept', 'application/x-ndjson');
    const response = await POST(request);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.type === 'complete')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', status: 504, stage: 'model', error: expect.stringContaining('等待模型解析结果') });
    expect(events.at(-1).requestId).toBeTruthy();
  });

  it('never starts analysis after cancellation during source verification', async () => {
    const record = recordWithStatus('🔴待领取'), controller = new AbortController();
    readWpsRecords.mockImplementation(async () => { controller.abort(); return { records: [record] }; });
    const request = new Request('http://localhost/api/wps-production/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [record] }), signal: controller.signal,
    });
    expect((await POST(request)).status).toBe(504);
    expect(analyzeRecords).not.toHaveBeenCalled();
  });
});
