import type { WpsProductionState } from './wps-production';
import { wpsSourceEvidence } from './wps-source';
import { ProductionArtworkConflictError } from './production-artwork-snapshot';

/** Freeze only the order being parsed, including shared versions and manual edits. */
export function wpsAnalysisSnapshot(state: WpsProductionState, recordId: string) {
  const record = state.records.find(record => record.source.recordId === recordId);
  return JSON.stringify({ batchId: state.batchId, record: record ? { source: wpsSourceEvidence(record.source), summary: record.summary, unitIds: record.unitIds } : null,
    units: state.units.filter(unit => unit.sourceRecordId === recordId),
    versions: state.mockupVersions.filter(version => version.sourceRecordId === recordId),
    shared: (state.sharedArtworks ?? []).filter(group => group.sourceRecordId === recordId),
  }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
}
export function assertWpsAnalysisSnapshot(state: WpsProductionState, recordId: string, expected: string) {
  if (wpsAnalysisSnapshot(state, recordId) !== expected) throw new ProductionArtworkConflictError('此订单的需求、图稿或共用关系已变化，本次解析结果未覆盖；请同步后重试');
}
