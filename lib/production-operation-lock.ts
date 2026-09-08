import { productionActionTarget } from '@/lib/production-artwork-snapshot';
import type { WpsProductionState } from '@/lib/wps-production';

export type ProductionOperation = { key: string; unitIds: string[]; batch: boolean; reason: string };

export function productionOperation(state: WpsProductionState, key: string, input: Record<string, unknown>, reason: string): ProductionOperation {
  const target = productionActionTarget(state, input);
  if (target) return { key, unitIds: target.unitIds, batch: false, reason };
  if (input.action === 'status') return { key, unitIds: state.units.filter(unit => unit.sourceRecordId === input.recordId).map(unit => unit.id), batch: false, reason };
  return { key, unitIds: [], batch: true, reason };
}

export function productionOperationsOverlap(left: ProductionOperation, right: ProductionOperation) {
  return left.batch || right.batch || left.key === right.key || left.unitIds.some(id => right.unitIds.includes(id));
}

/** Own the lock synchronously, including before React renders the disabled controls. */
export class ProductionOperationLocks {
  private active = new Map<string, ProductionOperation>();
  constructor(private changed: (operations: ProductionOperation[]) => void) {}
  get entries() { return [...this.active.values()]; }
  start(operation: ProductionOperation) {
    if (this.entries.some(active => productionOperationsOverlap(active, operation))) return null;
    this.active.set(operation.key, operation);
    this.changed(this.entries);
    return () => {
      if (this.active.get(operation.key) !== operation) return;
      this.active.delete(operation.key);
      this.changed(this.entries);
    };
  }
}
