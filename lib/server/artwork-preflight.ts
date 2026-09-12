import sharp from 'sharp';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit, WpsProductionState } from '@/lib/wps-production';
import { artworkInputSelection, artworkPlanIssues, isTextOnlyArtwork } from '@/lib/artwork-reference';
import { productionPreviewFixed, productionPreviewReadiness } from '@/lib/production-preview';
import { recoverProductionPrintSizes } from '@/lib/print-size-request';
import { sharedArtworkFixed, sharedArtworkForUnit } from '@/lib/shared-artwork';
import { fontReferenceInput } from '@/lib/artwork-font-reference';
import { compileArtworkRequirements, withSourceRequirements, isActiveSourceStatus, safeErrorText } from '@/lib/artwork-reliability';
import { readProductionFile } from './production-storage';
import { verifyWpsAnalysisSources } from './wps-analysis-save';
import { wpsConfigurationStatus } from './wps-dbsheet';
import { wpsSourceEvidence } from '@/lib/wps-source';
import { resolveProductionPreviewUnit } from './production-preview-readiness';

export type ArtworkPreflightTarget = 'artwork' | 'mockup' | 'preview';

export function preflightArtworkUnit(unit: ProductionUnit, source: SourceTaskRecord, target: ArtworkPreflightTarget, options: { fixed?: boolean } = {}) {
  const selection = artworkInputSelection(source, unit);
  // Recomposition consumes the saved PNG, not the old generation inputs.
  const contract = target === 'preview' ? compileArtworkRequirements({ instruction: '', layoutNote: '', primaryImageLabel: '', referenceImages: [] }) : compileArtworkRequirements(withSourceRequirements({
    sourceRequirementText: source.requirementText, instruction: unit.instruction, layoutNote: unit.layoutNote,
    exactText: unit.textMode === 'replace' ? unit.exactText : '', generationPrompt: unit.generationPrompt,
    primaryImageLabel: selection.primaryImageLabel, primaryImageRole: selection.primaryImageRole,
    referenceImages: selection.referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(m => m.id === id) + 1}` })),
    printPlacement: unit.placement, sourceScope: unit.sourceScope, fontReference: fontReferenceInput(source, unit),
  }));
  const blockers = target === 'preview' ? [] : [...artworkPlanIssues(source, unit), ...contract.issues.map(issue => issue.message)];
  if (source.wpsSource && !isActiveSourceStatus(source.wpsSource.status)) blockers.push('当前WPS状态不允许自动制作');
  const readiness = productionPreviewReadiness(unit, options);
  if (target !== 'artwork' && readiness.garmentIssue) blockers.push(`上衣预检：${readiness.garmentIssue}；可以独立制作或保留图稿`);
  if (target === 'preview' && readiness.artworkIssue) blockers.push(readiness.artworkIssue);
  return { contract, blockers: [...new Set(blockers)], ...readiness, target };
}
/** A request-local cache only. Never treat a URL as a permanent file identity. */
export async function verifyArtworkInputFiles(source: SourceTaskRecord, unit: ProductionUnit, cache = new Map<string, Promise<void>>()) {
  if (isTextOnlyArtwork(unit)) return;
  const selection = artworkInputSelection(source, unit);
  const ids = [...new Set([selection.primary?.id, ...selection.referenceMaterialIds].filter((id): id is string => !!id))];
  for (const id of ids) {
    const material = source.materials.find(item => item.id === id);
    if (!material?.url) throw new Error(`素材${id}没有可读取的原图；请同步或重新上传，不能静默使用缩略图代替制作原图`);
    const url = material.url;
    let pending = cache.get(url);
    if (!pending) {
      pending = (async () => {
        const bytes = await readProductionFile(url);
        if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('图像为空或超过64MB输入限制');
        const meta = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata();
        if (!meta.width || !meta.height || !['png', 'jpeg', 'webp', 'gif', 'tiff', 'svg', 'heif', 'avif'].includes(meta.format ?? '')) throw new Error('图像格式或尺寸不可识别');
      })();
      cache.set(url, pending);
    }
    try { await pending; }
    catch (error) { throw new Error(`素材${id}预检失败：${safeErrorText(error)}；本次尚未提交付费制作`); }
  }
}

/** Authorization and evidence are read from WPS at submission/execution, never cached across requests. */
export async function verifyLiveArtworkSource(source: SourceTaskRecord, cache = new Map<string, Promise<void>>()) {
  if (!source.wpsSource) return; // Legacy local/demo records have no WPS identity.
  // A deployment without WPS sync configured has no live source to re-read; the stored
  // status evidence still gates the route (assertActiveSourceStatus in the caller).
  if (!wpsConfigurationStatus().configured) return;
  const key = wpsSourceEvidence(source);
  let read = cache.get(key);
  if (!read) { read = verifyWpsAnalysisSources([source]); cache.set(key, read); }
  await read;
}

/** Garment checks are advisory for artwork-only work, blocking for composition.
 * Diagnostics uses exactly the same trusted resolution as execution, without a
 * model call, task save or implied confirmation.
 */
export async function preflightResolvedArtworkUnit(unit: ProductionUnit, source: SourceTaskRecord, target: ArtworkPreflightTarget, options: { fixed?: boolean } = {}) {
  // The preview API already applies this existing read-only legacy size recovery.
  // Use it here as well, without changing saved snapshots or fixed deliveries.
  if (!options.fixed) unit = recoverProductionPrintSizes({ units: [unit], mockupVersions: [], records: [{ source }] }).units[0];
  let resolved: ProductionUnit;
  try { resolved = await resolveProductionPreviewUnit(unit, options); }
  catch (error) {
    const checked = preflightArtworkUnit(unit, source, target, options);
    const garmentIssue = `衣服尺寸依据读取未完成：${safeErrorText(error)}；请到该款色核对衣身宽度`;
    return { ...checked, garmentIssue, garmentReady: false, previewReady: false,
      blockers: [...new Set([...checked.blockers, ...(target === 'artwork' ? [] : [`上衣预检：${garmentIssue}`])])] };
  }
  return preflightArtworkUnit(resolved, source, target, options);
}

/** New artwork is made once, but each mutable application needs its own garment
 * evidence. Match the existing automatic application policy: confirmed members
 * and independently preserved (version 0) drafts are not changed by this action.
 * This is a read-only selection, NOT an edit of membership or shared snapshots.
 */
export async function preflightArtworkOperation(state: WpsProductionState, unit: ProductionUnit, source: SourceTaskRecord, target: 'artwork' | 'mockup') {
  const group = sharedArtworkForUnit(state, unit.id);
  const sourceCheck = await preflightResolvedArtworkUnit(unit, source, 'artwork', { fixed: productionPreviewFixed(unit, state.mockupVersions) });
  const targets = group ? state.units.filter(member => group.unitIds.includes(member.id) && !sharedArtworkFixed(state, member.id)
    && !(member.id !== unit.id && member.artwork && member.sharedArtworkVersion === 0)) : [unit];
  const garmentChecks = await Promise.all(targets.map(async member => {
    const record = state.records.find(record => record.source.recordId === member.sourceRecordId)?.source ?? source;
    const checked = member.id === unit.id ? sourceCheck : await preflightResolvedArtworkUnit(member, record, 'artwork', { fixed: productionPreviewFixed(member, state.mockupVersions) });
    return { unitId: member.id, label: member.garmentLabel, garmentIssue: checked.garmentIssue,
      garmentReady: checked.garmentReady, previewReady: checked.previewReady, calibrationUrl: checked.calibrationUrl,
      temporaryPlacement: checked.temporaryPlacement };
  }));
  const failed = garmentChecks.filter(check => check.garmentIssue);
  return { ...sourceCheck, target, garmentChecks, garmentIssue: failed[0]?.garmentIssue ?? null,
    calibrationUrl: failed[0]?.calibrationUrl ?? sourceCheck.calibrationUrl,
    garmentReady: failed.length === 0, previewReady: garmentChecks.length > 0 && garmentChecks.every(check => check.previewReady),
    blockers: [...new Set([...sourceCheck.blockers, ...(target === 'mockup' ? failed.map(check => `${check.label}：上衣预检：${check.garmentIssue}；可以独立制作或保留图稿`) : [])])] };
}
