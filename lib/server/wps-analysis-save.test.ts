import { afterEach, expect, it, vi } from 'vitest';
import { taskReviewFixture } from '../testing/task-review-fixture';
import { listWpsSourceTaskRecords } from './wps-dbsheet';
import { verifyWpsAnalysisSources } from './wps-analysis-save';
vi.mock('./wps-dbsheet', () => ({ listWpsSourceTaskRecords: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it('rechecks the live source and eligibility, separately from production revision', async () => {
  const source = taskReviewFixture()[0].source;
  source.wpsSource = { fileId: 'test', sheetId: 1, sheetName: 'test', statusFieldName: 'status', status: '待领取', statusOptions: [] };
  const response = (records: typeof source[]) => ({ records }) as Awaited<ReturnType<typeof listWpsSourceTaskRecords>>;
  vi.mocked(listWpsSourceTaskRecords).mockResolvedValue(response([source]));
  await expect(verifyWpsAnalysisSources([source])).resolves.toBeUndefined();
  for (const records of [[], [{ ...source, requirementText: '新需求' }], [{ ...source, wpsSource: { ...source.wpsSource, status: '已完成' } }]]) {
    vi.mocked(listWpsSourceTaskRecords).mockResolvedValue(response(records));
    await expect(verifyWpsAnalysisSources([source])).rejects.toThrow('状态已变化');
  }
});
