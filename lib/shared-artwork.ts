import type { ProductionArtwork, ProductionUnit, WpsProductionState } from './wps-production';

export type SharedArtworkVersion = { number: number; artwork: ProductionArtwork; automaticTextColor: boolean; createdAt: string };
export type SharedArtwork = {
  id: string;
  sourceRecordId: string;
  sourceUnitId: string;
  unitIds: string[];
  versions: SharedArtworkVersion[];
  derivedFrom?: { id: string; version: number };
};

/** Explicit analysis references survive expansion. Old rows are suggestions only. */
export function sharedArtworkGroups(state: WpsProductionState): SharedArtwork[] {
  const groups = new Map((state.sharedArtworks ?? []).map(group => [group.id, { ...group, unitIds: [] as string[] }]));
  for (const unit of state.units) {
    if (!unit.sharedArtworkId) continue;
    let group = groups.get(unit.sharedArtworkId);
    if (!group) {
      group = { id: unit.sharedArtworkId, sourceRecordId: unit.sourceRecordId, sourceUnitId: unit.id, unitIds: [], versions: [] };
      groups.set(group.id, group);
    }
    if (group.sourceRecordId !== unit.sourceRecordId) throw new Error('共用图稿不能跨订单自动关联');
    group.unitIds.push(unit.id);
  }
  return [...groups.values()].filter(group => group.unitIds.length > 0).map(group => ({
    ...group, sourceUnitId: group.unitIds.includes(group.sourceUnitId) ? group.sourceUnitId : group.unitIds[0],
  }));
}
export function sharedArtworkForUnit(state: WpsProductionState, unitId: string) {
  return sharedArtworkGroups(state).find(group => group.unitIds.includes(unitId));
}
export function sharedArtworkLeader(state: WpsProductionState, unit: ProductionUnit) {
  const group = sharedArtworkForUnit(state, unit.id);
  return state.units.find(candidate => candidate.id === group?.sourceUnitId) ?? unit;
}
export function latestSharedArtwork(group: SharedArtwork) { return group.versions.at(-1); }
export function sharedArtworkUnit(state: WpsProductionState, group: SharedArtwork) {
  const unit = state.units.find(candidate => candidate.id === group.sourceUnitId)!;
  return { ...unit, artwork: latestSharedArtwork(group)?.artwork ?? unit.artwork };
}
export function sharedArtworkFixed(state: WpsProductionState, unitId: string) {
  return state.mockupVersions.some(version => version.unitIds.includes(unitId) && Boolean(version.finalConfirmation));
}

// This deliberately omits prose only for a visible suggestion; never auto-link by this key.
export function sharedArtworkCandidateKey(unit: ProductionUnit) {
  return JSON.stringify([unit.sourceRecordId, unit.materialId, [...unit.referenceMaterialIds].sort(), unit.sourceScope,
    unit.textMode, unit.exactText, unit.layoutNote, unit.variantLabel, unit.route, unit.artworkMethod ?? 'auto', unit.cutoutMode ?? 'auto']);
}
export function sharedArtworkSuggestions(state: WpsProductionState, recordId: string) {
  const groups = new Map<string, ProductionUnit[]>();
  for (const unit of state.units.filter(unit => unit.sourceRecordId === recordId && !unit.sharedArtworkId)) {
    if (!unit.materialId && !unit.exactText.trim()) continue;
    const key = sharedArtworkCandidateKey(unit);
    groups.set(key, [...(groups.get(key) ?? []), unit]);
  }
  return [...groups.values()].filter(units => units.length > 1);
}

export function bindSharedArtwork(state: WpsProductionState, sourceUnitId: string, targetUnitIds: string[], id: string): WpsProductionState {
  const source = state.units.find(unit => unit.id === sourceUnitId);
  if (!source) throw new Error('找不到共用源稿');
  const ids = [...new Set([sourceUnitId, ...targetUnitIds])];
  if (ids.length < 2 || ids.length > 100) throw new Error('请选择 2–100 个应用位置');
  const existing = sharedArtworkForUnit(state, sourceUnitId);
  const targets = ids.map(unitId => {
    const unit = state.units.find(unit => unit.id === unitId);
    if (!unit || unit.sourceRecordId !== source.sourceRecordId) throw new Error('只能关联同一订单内的位置');
    if (unit.sharedArtworkId && unit.sharedArtworkId !== existing?.id) throw new Error('该位置已使用其他共用图稿，请先单独拆出');
    if (unit.id !== source.id && sharedArtworkCandidateKey(unit) !== sharedArtworkCandidateKey(source)) throw new Error('图稿的素材、取材、文字或版式不同，不能直接共用；请另建版本');
    if (unit.attempts.some(attempt => ['submitted', 'processing', 'unknownSubmission'].includes(attempt.status))) throw new Error('已有制作任务尚未结束');
    return unit;
  });
  const group: SharedArtwork = existing ?? { id, sourceRecordId: source.sourceRecordId, sourceUnitId, unitIds: [], versions: [] };
  const memberIds = [...new Set([...group.unitIds, ...ids])];
  const now = new Date().toISOString();
  return { ...state, revision: state.revision + 1, updatedAt: now,
    units: state.units.map(unit => targets.some(target => target.id === unit.id) ? { ...unit, sharedArtworkId: group.id, sharedArtworkDetached: false, sharedArtworkVersion: unit.sharedArtworkVersion ?? 0, updatedAt: now } : unit),
    sharedArtworks: [...(state.sharedArtworks ?? []).filter(item => item.id !== group.id), { ...group, unitIds: memberIds }],
  };
}

export function detachSharedArtwork(state: WpsProductionState, unitId: string, branchId?: string): WpsProductionState {
  const unit = state.units.find(unit => unit.id === unitId);
  const group = sharedArtworkForUnit(state, unitId);
  if (!unit || !group) throw new Error('此处没有共用图稿');
  const now = new Date().toISOString();
  const units = state.units.map(candidate => candidate.id === unitId ? { ...candidate, sharedArtworkId: branchId,
    sharedArtworkDetached: !branchId, sharedArtworkVersion: branchId ? unit.artwork ? 1 : 0 : undefined, sharedArtworkError: undefined, updatedAt: now } : candidate);
  const groups = sharedArtworkGroups({ ...state, units });
  if (branchId) {
    const branch = groups.find(item => item.id === branchId)!;
    branch.derivedFrom = { id: group.id, version: unit.sharedArtworkVersion ?? 0 };
    branch.versions = unit.artwork ? [{ number: 1, artwork: unit.artwork, automaticTextColor: false, createdAt: now }] : [];
  }
  return { ...state, units, sharedArtworks: groups, revision: state.revision + 1, updatedAt: now };
}

export function assertSharedArtworks(state: WpsProductionState) {
  const ids = new Set<string>();
  for (const group of state.sharedArtworks ?? []) {
    if (!group.id || ids.has(group.id) || !Array.isArray(group.unitIds) || !Array.isArray(group.versions)) throw new Error('共用图稿结构无效');
    ids.add(group.id);
    if (!state.records.some(record => record.source.recordId === group.sourceRecordId)) throw new Error('共用图稿来源订单不存在');
    if (new Set(group.unitIds).size !== group.unitIds.length) throw new Error('共用图稿包含重复应用');
    for (const id of group.unitIds) if (!state.units.some(unit => unit.id === id && unit.sourceRecordId === group.sourceRecordId && unit.sharedArtworkId === group.id)) throw new Error('共用图稿应用关系无效');
    if (!group.unitIds.includes(group.sourceUnitId)) throw new Error('共用图稿的制作入口已变化');
    for (const [index, version] of group.versions.entries()) if (version.number !== index + 1 || !version.artwork || typeof version.automaticTextColor !== 'boolean') throw new Error('共用图稿版本无效');
  }
  for (const unit of state.units) {
    if (unit.sharedArtworkId !== undefined && (typeof unit.sharedArtworkId !== 'string' || !unit.sharedArtworkId || unit.sharedArtworkId.length > 500)) throw new Error('共用图稿标识无效');
    if (unit.sharedArtworkDetached !== undefined && typeof unit.sharedArtworkDetached !== 'boolean') throw new Error('共用图稿脱离状态无效');
    if (unit.sharedArtworkVersion !== undefined && (!Number.isInteger(unit.sharedArtworkVersion) || unit.sharedArtworkVersion < 0)) throw new Error('应用图稿版本无效');
    if (unit.sharedArtworkId && unit.sharedArtworkVersion && unit.sharedArtworkVersion > (sharedArtworkForUnit(state, unit.id)?.versions.length ?? 0)) throw new Error('应用图稿版本不存在');
  }
}
