import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceTaskRecord } from '@/lib/batch-task-review';

const verifySpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/server/wps-analysis-save', () => ({ verifyWpsAnalysisSources: verifySpy }));

import { verifyLiveArtworkSource } from '@/lib/server/artwork-preflight';

const WPS_ENV = ['WPS_AIRSCRIPT_WEBHOOK', 'WPS_AIRSCRIPT_TOKEN', 'WPS_SOURCE_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of WPS_ENV) { saved[name] = process.env[name]; delete process.env[name]; }
  verifySpy.mockClear();
});
afterEach(() => {
  for (const name of WPS_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function source(withWps: boolean): SourceTaskRecord {
  return {
    recordId: 'preflight-live-1',
    customerId: 'customer',
    revision: '1',
    requirementText: '正面 图一',
    productStyleText: 'B01SD 黑色',
    materials: [{ id: 'm1', name: '图一', url: 'https://cdn.example.com/a.png' }],
    ...(withWps ? { wpsSource: { fileId: 'fixture', sheetId: 1, sheetName: 'fixture', statusFieldName: '任务状态', status: '设计中', statusOptions: [] } } : {}),
  } as SourceTaskRecord;
}

describe('verifyLiveArtworkSource', () => {
  it('legacy records without WPS identity skip live verification entirely', async () => {
    await verifyLiveArtworkSource(source(false));
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('a deployment without WPS sync configured has no live source to re-read and skips verification', async () => {
    await verifyLiveArtworkSource(source(true));
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('with WPS sync configured the live source is re-read per submission and never cached across requests', async () => {
    for (const name of WPS_ENV) process.env[name] = 'https://configured.example';
    const record = source(true);
    const requestCache = new Map<string, Promise<void>>();
    await verifyLiveArtworkSource(record, requestCache);
    await verifyLiveArtworkSource(record, requestCache);
    expect(verifySpy).toHaveBeenCalledTimes(1); // one in-flight read per request-local cache
    await verifyLiveArtworkSource(record); // a new request defaults to a fresh cache and re-reads live evidence
    expect(verifySpy).toHaveBeenCalledTimes(2);
    expect(verifySpy).toHaveBeenCalledWith([record]);
  });

  it('live verification failures surface to the caller instead of being swallowed', async () => {
    for (const name of WPS_ENV) process.env[name] = 'https://configured.example';
    verifySpy.mockRejectedValueOnce(new Error('WPS 原文、附件或任务状态已变化，请同步后重试解析'));
    await expect(verifyLiveArtworkSource(source(true))).rejects.toThrow('WPS 原文');
  });
});
