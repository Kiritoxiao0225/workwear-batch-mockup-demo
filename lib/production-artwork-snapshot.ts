import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit, WpsProductionState } from '@/lib/wps-production';
import { wpsSourceEvidence } from '@/lib/wps-source';
import { sharedArtworkForUnit } from './shared-artwork';

/** Compare only this task and its source, so unrelated completed jobs can be saved. */
export function productionArtworkSnapshot(unit: ProductionUnit, source: SourceTaskRecord) {
  return JSON.stringify({
    id: unit.id, updatedAt: unit.updatedAt, recipe: unit.recipeFingerprint, plan: unit.planFingerprint,
    artwork: unit.artwork?.validation.sha256 ?? null,
    lastAttempt: unit.attempts.at(-1)?.id ?? null, gateA: unit.gateA, gateB: unit.gateB,
    ...(unit.sharedArtworkId ? { shared: [unit.sharedArtworkId, unit.sharedArtworkVersion ?? 0] } : {}),
    source: wpsSourceEvidence(source),
    // Include preview-only assets too; a changed source must never be hidden by a fallback.
    previews: source.materials.map(material => [material.id, material.originalPreviewUrl ?? material.previewUrl ?? null]),
  });
}

export class ProductionArtworkConflictError extends Error {}
export function productionSharedSnapshot(state: WpsProductionState, unitId: string, extraIds: string[] = []) {
  const group = sharedArtworkForUnit(state, unitId);
  const ids = [...new Set([unitId, ...(group?.unitIds ?? []), ...extraIds])].sort();
  return JSON.stringify({ group: group ?? null, units: ids.map(id => {
    const unit = state.units.find(unit => unit.id === id);
    const source = state.records.find(record => record.source.recordId === unit?.sourceRecordId)?.source;
    if (!unit || !source) throw new ProductionArtworkConflictError('应用位置已变化');
    return JSON.parse(productionArtworkSnapshot(unit, source));
  }), versions: state.mockupVersions.filter(version => version.unitIds.some(id => ids.includes(id))).map(version => [version.id, version.status, version.finalConfirmation]) });
}
export function assertProductionSharedSnapshot(state: WpsProductionState, unitId: string, expected: string, extraIds: string[] = []) {
  if (!sameSnapshot(productionSharedSnapshot(state, unitId, extraIds), expected)) throw new ProductionArtworkConflictError('共用图稿或应用位置已变化，请重新打开后再操作');
}
const sharedActions = new Set(['linkSharedArtwork', 'detachSharedArtwork', 'branchSharedArtwork', 'applySharedArtwork', 'confirmSharedArtwork']);
const sharedWrites = new Set(['submitArtwork', 'saveArtworkDraft', 'normalizeTextPlan', 'startGptImage2', 'pollGptImage2']);
// PostgreSQL jsonb reorders object keys. Compare snapshot content, preserving
// array order and values, including the serialized unit snapshots in a version.
function sameSnapshot(actual: string, expected: string) {
  if (actual === expected) return true;
  const canonical = (snapshot: string) => {
    const value = JSON.parse(snapshot);
    if (value && Array.isArray(value.units)) value.units = value.units.map((unit: unknown) => typeof unit === 'string' ? JSON.parse(unit) : unit);
    return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
  };
  try { return canonical(actual) === canonical(expected); } catch { return false; }
}
export function assertProductionArtworkSnapshot(state: WpsProductionState, unitId: string, expected: string) {
  const unit = state.units.find(unit => unit.id === unitId);
  const record = state.records.find(record => record.source.recordId === unit?.sourceRecordId);
  if (!unit || !record || !sameSnapshot(productionArtworkSnapshot(unit, record.source), expected)) {
    throw new ProductionArtworkConflictError('这张图案的要求、素材或状态已变化，已停止覆盖；请同步后核对');
  }
}

const versionActions = new Set(['selectGarment', 'savePlacements', 'composeVersion', 'approveVersion', 'returnUnit']);
const unitActions = new Set(['updatePlan', 'confirmPlan', 'confirmArtwork', 'saveTextVerification', 'placeArtwork', 'checkArtworkQuality', 'startGptImage2', 'pollGptImage2', 'submitArtwork', 'saveArtworkDraft', 'normalizeTextPlan']);

/** The server derives the scope from the action, never from client-supplied unit lists. */
export function productionActionTarget(state: WpsProductionState, input: Record<string, unknown>) {
  const action = String(input.action);
  const shared = sharedArtworkForUnit(state, String(input.unitId));
  if (sharedActions.has(action) || (sharedWrites.has(action) && shared)) {
    const ids = [...new Set([String(input.unitId), ...(shared?.unitIds ?? []), ...(Array.isArray(input.targetUnitIds) ? input.targetUnitIds.map(String) : [])])];
    if (ids.some(id => !state.units.some(unit => unit.id === id))) throw new ProductionArtworkConflictError('应用位置已变化');
    return { version: null, unitIds: ids };
  }
  if (versionActions.has(action)) {
    const firstUpdate = Array.isArray(input.updates) ? input.updates[0] : undefined;
    const unitId = action === 'savePlacements' ? firstUpdate?.unitId : input.unitId;
    const version = state.mockupVersions.find(version => action === 'selectGarment' || action === 'savePlacements'
      ? version.unitIds.includes(String(unitId)) : version.id === input.versionId);
    if (!version) throw new ProductionArtworkConflictError('服装版本已变化，请重新打开后核对');
    return { version, unitIds: version.unitIds };
  }
  if (unitActions.has(action)) {
    if (!state.units.some(unit => unit.id === input.unitId)) throw new ProductionArtworkConflictError('图案已变化，请重新打开后核对');
    return { version: null, unitIds: [String(input.unitId)] };
  }
  return null;
}

export function productionActionSnapshot(state: WpsProductionState, input: Record<string, unknown>): { expectedUnitSnapshot?: string; expectedVersionSnapshot?: string; expectedSharedSnapshot?: string } {
  const target = productionActionTarget(state, input);
  if (!target) return {};
  const units = target.unitIds.map(id => {
    const unit = state.units.find(unit => unit.id === id)!;
    const source = state.records.find(record => record.source.recordId === unit?.sourceRecordId)?.source;
    if (!unit || !source) throw new ProductionArtworkConflictError('图案或原始素材已变化，请重新核对');
    return productionArtworkSnapshot(unit, source);
  });
  return target.version
    ? { expectedVersionSnapshot: JSON.stringify({ batchId: state.batchId, version: target.version, units }) }
    : { expectedUnitSnapshot: units[0], ...((sharedActions.has(String(input.action)) || (sharedWrites.has(String(input.action)) && sharedArtworkForUnit(state, String(input.unitId))))
      ? { expectedSharedSnapshot: productionSharedSnapshot(state, String(input.unitId), Array.isArray(input.targetUnitIds) ? input.targetUnitIds.map(String) : []) } : {}) };
}

/** Legacy clients keep strict revision checks; scoped clients are rechecked on every CAS retry. */
export function productionActionAssertion(input: Record<string, unknown>) {
  if (input.expectedUnitSnapshot === undefined && input.expectedVersionSnapshot === undefined) return undefined;
  for (const key of ['expectedUnitSnapshot', 'expectedVersionSnapshot']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 3_000_000)) throw new Error(`${key} 无效`);
  }
  return (state: WpsProductionState) => {
    if (input.expectedSharedSnapshot !== undefined) {
      if (typeof input.expectedSharedSnapshot !== 'string' || input.expectedSharedSnapshot.length > 10_000_000) throw new Error('共用图稿快照无效');
      assertProductionSharedSnapshot(state, String(input.unitId), input.expectedSharedSnapshot, Array.isArray(input.targetUnitIds) ? input.targetUnitIds.map(String) : []);
    }
    const actual = productionActionSnapshot(state, input);
    if (actual.expectedSharedSnapshot && input.expectedSharedSnapshot === undefined) throw new ProductionArtworkConflictError('共用图稿需要完整应用快照，请刷新后重试');
    const key = actual.expectedVersionSnapshot !== undefined ? 'expectedVersionSnapshot' : 'expectedUnitSnapshot';
    if (!actual[key] || !sameSnapshot(actual[key], String(input[key]))) throw new ProductionArtworkConflictError(key === 'expectedVersionSnapshot'
      ? '本服装版本的图案、位置或成品已变化，请重新打开后核对'
      : '这张图案的要求、素材或状态已变化，请重新打开后核对再保存或确认');
  };
}

/** Concurrent responses may arrive out of order. Never replace newer state with older state. */
export function newerProductionState(current: WpsProductionState | null, incoming: WpsProductionState) {
  return current && current.batchId === incoming.batchId && current.revision > incoming.revision ? current : incoming;
}
