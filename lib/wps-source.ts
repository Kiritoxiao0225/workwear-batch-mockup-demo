import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionRecord, WpsProductionState } from '@/lib/wps-production';

export function canAnalyzeWpsTask(source: SourceTaskRecord) {
  return ['🔴待领取', '🟢设计中', '待领取', '设计中'].includes(source.wpsSource?.status ?? '');
}

export function pendingWpsAnalysisRecords(records: ProductionRecord[]) {
  return records.filter((record) => canAnalyzeWpsTask(record.source) && record.unitIds.length === 0 && record.source.requirementText.trim());
}

export function orderWpsSourceRecords(previous: SourceTaskRecord[], incoming: SourceTaskRecord[]) {
  const previousIds = new Set(previous.map((record) => record.recordId));
  const byId = new Map(incoming.map((record) => [record.recordId, record]));
  return [...incoming.filter((record) => !previousIds.has(record.recordId)),
    ...previous.flatMap((record) => { const current = byId.get(record.recordId); return current ? [current] : []; })];
}

// Status and row location may change without changing the artwork brief.
function materialEvidenceUrl(value: string | null | undefined) {
  if (!value) return value;
  try {
    const url = new URL(value);
    // WPS renews these authentication parameters without changing FileId or bytes.
    for (const key of [...url.searchParams.keys()]) {
      if (['expires', 'kssaccesskeyid', 'signature', 'response-cache-control'].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return value; }
}
export function wpsSourceEvidence(record: SourceTaskRecord) {
  return JSON.stringify({
    recordId: record.recordId,
    customerId: record.customerId,
    revision: record.revision,
    requirementText: record.requirementText,
    productStyleText: record.productStyleText,
    materials: record.materials.map((material) => ({ id: material.id, url: materialEvidenceUrl(material.originalUrl ?? material.url) })),
  });
}

export function liveWpsProductionState(state: WpsProductionState, sources: SourceTaskRecord[]): WpsProductionState {
  const records = sources.map((source) => {
    const existing = state.records.find((record) => record.source.recordId === source.recordId
      && wpsSourceEvidence(record.source) === wpsSourceEvidence(source));
    return existing ? { ...existing, source: { ...source, materials: source.materials.map(material => { const stored = existing.source.materials.find(item => item.id === material.id); return stored?.originalUrl ? { ...material, originalUrl: stored.originalUrl, originalPreviewUrl: stored.originalPreviewUrl, url: stored.url, previewUrl: stored.previewUrl } : material; }) } } : { source, summary: !source.requirementText.trim()
      ? '待完善；WPS 新记录已同步，填写需求后将自动更新'
      : canAnalyzeWpsTask(source) ? '待分析；原文和素材已同步' : '原文和素材已同步；当前状态不参与分析', unitIds: [] };
  });
  const unitIds = new Set(records.flatMap((record) => record.unitIds));
  return {
    ...state,
    records,
    units: state.units.filter((unit) => unitIds.has(unit.id)),
    mockupVersions: state.mockupVersions.filter((version) => version.unitIds.every((id) => unitIds.has(id))),
  };
}
