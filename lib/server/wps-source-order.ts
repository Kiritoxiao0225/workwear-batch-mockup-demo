import type { SourceTaskRecord } from '@/lib/batch-task-review';
import { mergeWpsSourceOrder, orderWpsSourceRecords } from '@/lib/wps-source';
import { mutateWpsProductionState, ProductionRevisionConflictError, readWpsProductionState } from './wps-production-store';

/** Only discovery changes the order. Never persist the live source payload or
 * touch artwork here; concurrent production saves are re-read before retrying. */
export async function persistWpsSourceOrder(records: SourceTaskRecord[]) {
  const ids = records.map(record => record.recordId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await readWpsProductionState();
    const previous = state.sourceRecordOrder ?? [];
    const order = mergeWpsSourceOrder(previous, ids);
    if (order.length === previous.length) return orderWpsSourceRecords(previous, records);
    try {
      const saved = await mutateWpsProductionState(state.revision, current => ({
        ...current,
        sourceRecordOrder: order,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }));
      return orderWpsSourceRecords(saved.sourceRecordOrder!, records);
    } catch (error) {
      if (!(error instanceof ProductionRevisionConflictError) || attempt === 4) throw error;
    }
  }
  throw new Error('任务排序保存冲突，请重新同步');
}
