import sharp from 'sharp';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import { artworkInputSelection, artworkPlanIssues, isTextOnlyArtwork } from '@/lib/artwork-reference';
import { garmentPlacementIssue } from '@/lib/production-garment';
import { fontReferenceInput } from '@/lib/artwork-font-reference';
import { compileArtworkRequirements, withSourceRequirements, isActiveSourceStatus, safeErrorText } from '@/lib/artwork-reliability';
import { readProductionFile } from './production-storage';
import { verifyWpsAnalysisSources } from './wps-analysis-save';
import { wpsConfigurationStatus } from './wps-dbsheet';
import { wpsSourceEvidence } from '@/lib/wps-source';
import { withGarmentBodyScale } from './wps-garment-sizing';

export function preflightArtworkUnit(unit: ProductionUnit, source: SourceTaskRecord, target: 'artwork' | 'mockup') {
  const selection = artworkInputSelection(source, unit);
  const contract = compileArtworkRequirements(withSourceRequirements({
    sourceRequirementText: source.requirementText, instruction: unit.instruction, layoutNote: unit.layoutNote,
    exactText: unit.textMode === 'replace' ? unit.exactText : '', generationPrompt: unit.generationPrompt,
    primaryImageLabel: selection.primaryImageLabel, primaryImageRole: selection.primaryImageRole,
    referenceImages: selection.referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(m => m.id === id) + 1}` })),
    printPlacement: unit.placement, sourceScope: unit.sourceScope, fontReference: fontReferenceInput(source, unit),
  }));
  const blockers = [...artworkPlanIssues(source, unit), ...contract.issues.map(issue => issue.message)];
  if (source.wpsSource && !isActiveSourceStatus(source.wpsSource.status)) blockers.push('当前WPS状态不允许自动制作');
  const garmentIssue = garmentPlacementIssue(unit.garment, unit.placement);
  if (target === 'mockup' && garmentIssue) blockers.push(`图稿不需要重做；上衣预检：${garmentIssue}`);
  return { contract, blockers: [...new Set(blockers)], garmentIssue, target };
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

/** Resolve legitimate catalog/alpha geometry before declaring an unconfirmed binding unusable. */
export async function preflightResolvedArtworkUnit(unit: ProductionUnit, source: SourceTaskRecord, target: 'artwork' | 'mockup') {
  if (target === 'mockup' && unit.garment && !unit.gateA) {
    try { return preflightArtworkUnit({ ...unit, garment: await withGarmentBodyScale(unit.garment) }, source, target); }
    catch (error) { const checked = preflightArtworkUnit(unit, source, target); return { ...checked, blockers: [...checked.blockers, `衣服几何读取失败：${safeErrorText(error)}`] }; }
  }
  return preflightArtworkUnit(unit, source, target);
}
