import { beforeEach, expect, it, vi } from 'vitest';
import { persistWpsSourceOrder } from './wps-source-order';
import { readCloudProductionSourceOrder } from './production-cloud-state';
import { mutateWpsProductionState, readWpsProductionState } from './wps-production-store';
import { emptyWpsProductionState } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';

vi.mock('./production-storage', () => ({ usesProductionCloud: () => true }));
vi.mock('./production-cloud-state', () => ({ readCloudProductionSourceOrder: vi.fn() }));
vi.mock('./wps-production-store', () => ({
  readWpsProductionState: vi.fn(), mutateWpsProductionState: vi.fn(), ProductionRevisionConflictError: class extends Error {},
}));
beforeEach(() => vi.resetAllMocks());
const records = taskReviewFixture().slice(0, 2).map(review => review.source);
it('does not download or rewrite artwork state during unchanged source polling', async () => {
  const order = records.map(record => record.recordId).reverse();
  vi.mocked(readCloudProductionSourceOrder).mockResolvedValue(order);
  expect((await persistWpsSourceOrder(records)).map(record => record.recordId)).toEqual(order);
  expect(readWpsProductionState).not.toHaveBeenCalled();
  expect(mutateWpsProductionState).not.toHaveBeenCalled();
});
it('re-reads full current state before saving newly discovered tasks', async () => {
  vi.mocked(readCloudProductionSourceOrder).mockResolvedValue([records[0].recordId]);
  const current = { ...emptyWpsProductionState(), revision: 8, sourceRecordOrder: records.map(record => record.recordId).reverse() };
  vi.mocked(readWpsProductionState).mockResolvedValue(current);
  expect((await persistWpsSourceOrder(records)).map(record => record.recordId)).toEqual(current.sourceRecordOrder);
  expect(readWpsProductionState).toHaveBeenCalledOnce();
  expect(mutateWpsProductionState).not.toHaveBeenCalled();
});
it('reports a failed order read without silently treating it as an empty workspace', async () => {
  vi.mocked(readCloudProductionSourceOrder).mockRejectedValue(new Error('database timeout'));
  await expect(persistWpsSourceOrder(records)).rejects.toThrow('database timeout');
  expect(readWpsProductionState).not.toHaveBeenCalled();
  expect(mutateWpsProductionState).not.toHaveBeenCalled();
});
