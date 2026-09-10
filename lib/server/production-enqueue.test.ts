import { beforeEach, expect, it, vi } from 'vitest';
import { importTaskReviews, emptyWpsProductionState, type WpsProductionState } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { wpsAnalysisSnapshot } from '@/lib/wps-analysis-snapshot';
import { enqueueWpsAnalysis } from './wps-analysis-jobs';

const mock = vi.hoisted(() => ({ read: vi.fn(), query: vi.fn(), transaction: vi.fn(), inside: false }));
vi.mock('./production-cloud-state', () => ({ readCloudProductionState: mock.read }));
vi.mock('./catalog-database', () => ({ catalogDatabase: () => ({ query: mock.query }), catalogTransaction: mock.transaction }));
const review = () => {
  const item = structuredClone(taskReviewFixture()[0]);
  item.source.wpsSource = { fileId: 'fixture', sheetId: 1, sheetName: 'fixture', statusFieldName: 'status', status: '待领取', statusOptions: [] };
  item.source.materials = item.source.materials.map(material => ({ ...material, url: null, previewUrl: null }));
  return item;
};
beforeEach(() => {
  vi.resetAllMocks(); mock.inside = false;
  mock.transaction.mockImplementation(async operation => {
    mock.inside = true;
    try { return await operation({ query: mock.query }); } finally { mock.inside = false; }
  });
});
it('unchanged parsed orders never acquire a production row lock or open a queue transaction', async () => {
  const item = review();
  mock.read.mockResolvedValue(importTaskReviews(emptyWpsProductionState(), [item]));
  expect(await enqueueWpsAnalysis(item.source)).toEqual({ id: null, status: 'completed' });
  expect(mock.transaction).not.toHaveBeenCalled();
});
it('transfers state without a lock and retries a revision race before freezing the target', async () => {
  const item = review();
  const before = emptyWpsProductionState();
  const after: WpsProductionState = { ...before, revision: before.revision + 1, batchId: 'new-batch' };
  mock.read.mockImplementation(async () => {
    expect(mock.inside).toBe(false);
    return mock.read.mock.calls.length === 1 ? before : after;
  });
  mock.query.mockImplementation(async (sql: string) => {
    expect(sql).not.toContain('state_jsonb');
    return { rows: sql.startsWith('SELECT revision') ? [{ revision: after.revision }] : [], rowCount: 0 };
  });
  expect((await enqueueWpsAnalysis(item.source)).status).toBe('queued');
  expect(mock.read).toHaveBeenCalledTimes(2);
  const inserts = mock.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO wps_analysis_jobs('));
  expect(inserts).toHaveLength(1);
  expect(inserts[0][1][6]).toBe(wpsAnalysisSnapshot(after, item.source.recordId));
});
it('stops safely when the state keeps changing, without creating any paid work', async () => {
  const state = emptyWpsProductionState();
  mock.read.mockResolvedValue(state);
  mock.query.mockResolvedValue({ rows: [{ revision: state.revision + 1 }], rowCount: 1 });
  await expect(enqueueWpsAnalysis(review().source)).rejects.toThrow('尚未提交解析');
  expect(mock.query.mock.calls.every(([sql]) => sql.startsWith('SELECT revision'))).toBe(true);
});
