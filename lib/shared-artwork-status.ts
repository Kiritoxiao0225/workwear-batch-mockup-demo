import { artworkAcceptanceIssues } from './artwork-acceptance';
import { latestSharedArtwork, sharedArtworkFixed, sharedArtworkForUnit, type SharedArtwork } from './shared-artwork';
import type { ProductionUnit, WpsProductionState } from './wps-production';

export function sharedArtworkApplication(state: WpsProductionState, group: SharedArtwork, unit: ProductionUnit) {
  const version = latestSharedArtwork(group);
  const current = Boolean(version && unit.artwork && unit.sharedArtworkVersion === version.number);
  const fixed = sharedArtworkFixed(state, unit.id);
  const preserved = Boolean(unit.artwork && (fixed || unit.sharedArtworkVersion === 0));
  const issues = unit.artwork ? artworkAcceptanceIssues(unit.artwork.validation) : [];
  const ready = current && unit.artwork!.validation.valid && !issues.length && unit.artwork!.recipeFingerprint === unit.recipeFingerprint;
  const confirmed = ready && unit.gateB?.fingerprint === unit.artwork!.validation.sha256;
  const status = fixed ? current ? '已定稿' : `已定稿 · 保留${unit.sharedArtworkVersion ? ` v${unit.sharedArtworkVersion}` : '原稿'}`
    : unit.sharedArtworkError ? '应用失败'
    : !version ? '待制作'
    : preserved ? '保留独立稿'
    : !current ? `待应用 v${version.number}`
    : !ready ? '图案待修正'
    : confirmed ? '已确认' : '已应用 · 待确认';
  return { unit, current, fixed, preserved, confirmed, status,
    error: fixed ? undefined : unit.sharedArtworkError || (current && !ready ? issues.join('；') || '图案与当前要求不一致，请编辑或重新制作后核对。' : undefined),
    canApply: Boolean(version && !fixed && (!current || unit.sharedArtworkError)),
    canConfirm: Boolean(ready && !fixed && !confirmed && !unit.sharedArtworkError),
  };
}

export function sharedArtworkStatus(state: WpsProductionState, group: SharedArtwork) {
  const applications = group.unitIds.map(id => sharedArtworkApplication(state, group, state.units.find(unit => unit.id === id)!));
  const applied = applications.filter(item => item.current && !item.error).length;
  const confirmed = applications.filter(item => item.confirmed && !item.error).length;
  const preserved = applications.filter(item => item.preserved && !item.current).length;
  const failed = applications.filter(item => item.error).length;
  const pending = applications.length - applied - preserved;
  const confirmable = applications.filter(item => item.canConfirm).length;
  const complete = applications.every(item => item.fixed || item.confirmed && !item.error);
  return { applications, applied, confirmed, preserved, failed, pending, confirmable, complete,
    summary: latestSharedArtwork(group)
      ? `已应用 ${applied}/${applications.length} 处 · 已确认 ${confirmed} 处${preserved ? ` · ${preserved} 处保留原稿` : ''}${failed ? ` · ${failed} 处需处理` : ''}`
      : `共 ${applications.length} 处，制作一次后自动应用`,
  };
}

export function productionActionError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/statement timeout|canceling statement|timeout/i.test(detail)) return `服务响应超时：${detail}`;
  if (/fetch failed|failed to fetch|network/i.test(detail)) return `网络连接中断：${detail}`;
  return detail;
}

export type ProductionActionFeedback = {
  status: 'saving' | 'saved' | 'error' | 'unknown';
  message: string;
  detail?: string;
};

/** A lost response is only a success when the requested applications can be read back. */
export function sharedActionCompleted(before: WpsProductionState, after: WpsProductionState, input: Record<string, unknown>) {
  const id = String(input.unitId);
  const oldGroup = sharedArtworkForUnit(before, id), group = sharedArtworkForUnit(after, id);
  if (input.action === 'confirmSharedArtwork' && oldGroup && group && oldGroup.id === group.id) {
    const targets = sharedArtworkStatus(before, oldGroup).applications.filter(item => item.canConfirm);
    return targets.length > 0 && targets.every(target => {
      const unit = after.units.find(unit => unit.id === target.unit.id);
      return unit && unit.artwork?.validation.sha256 === target.unit.artwork?.validation.sha256
        && unit.gateB?.fingerprint === target.unit.artwork?.validation.sha256;
    });
  }
  if (input.action === 'applySharedArtwork' && oldGroup && group) {
    const unit = after.units.find(unit => unit.id === id);
    return Boolean(group.id === oldGroup.id && latestSharedArtwork(oldGroup) && unit?.artwork
      && unit.sharedArtworkVersion === latestSharedArtwork(oldGroup)!.number && !unit.sharedArtworkError);
  }
  if (input.action === 'linkSharedArtwork' && group && Array.isArray(input.targetUnitIds))
    return input.targetUnitIds.length > 0 && input.targetUnitIds.every(id => group.unitIds.includes(String(id)));
  if (input.action === 'detachSharedArtwork') return Boolean(oldGroup && after.units.some(unit => unit.id === id && !unit.sharedArtworkId));
  if (input.action === 'branchSharedArtwork') return Boolean(oldGroup && group && group.id !== oldGroup.id && group.derivedFrom?.id === oldGroup.id);
  return false;
}
