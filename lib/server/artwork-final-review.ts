import { fontReferenceInput, fontReferenceRequirement } from '@/lib/artwork-font-reference';
import { cropFontReference } from './artwork-font-reference';
import { createHash } from 'node:crypto';
import { applyFinalArtworkReview, type ArtworkReviewLedger, type ReviewCategory } from '@/lib/artwork-review-ledger';
import { artworkInputSelection } from '@/lib/artwork-reference';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import type { ArtworkEditCheck, ArtworkEditVerification } from '@/lib/artwork-model-edits';
import { readProductionFile } from './production-storage';
import { verifyArtworkModelEdits } from './artwork-content-inspection';
import { compileArtworkRequirements, FINAL_EVIDENCE_VERSION, canonicalJson, safeErrorText } from '@/lib/artwork-reliability';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const roleLabels: Record<string, string> = { content: '成品内容', font: '字体', color: '配色', layout: '排版', reference: '样式' };

function requirementInput(unit: ProductionUnit, source: SourceTaskRecord) {
  const selection = artworkInputSelection(source, unit);
  return { selection, contract: compileArtworkRequirements({ sourceRequirementText: source.requirementText,
    instruction: unit.instruction, layoutNote: unit.layoutNote, exactText: unit.exactText, generationPrompt: unit.generationPrompt,
    primaryImageLabel: selection.primaryImageLabel, primaryImageRole: selection.primaryImageRole,
    referenceImages: selection.referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(m => m.id === id) + 1}` })),
    printPlacement: unit.placement, sourceScope: unit.sourceScope, fontReference: fontReferenceInput(source, unit) }) };
}
/** Include actual source bytes in the checkpoint, not just expiring URLs or guessed OCR. */
export async function finalArtworkEvidenceKey(unit: ProductionUnit, source: SourceTaskRecord) {
  const { selection, contract } = requirementInput(unit, source);
  const ids = [...new Set([selection.primary?.id, ...selection.referenceMaterialIds].filter(Boolean))];
  const materials = [];
  for (const id of ids) {
    const m = source.materials.find(item => item.id === id);
    try { materials.push({ id, sha256: m?.url ? sha(await readProductionFile(m.url)) : null }); }
    catch { materials.push({ id, sha256: null }); }
  }
  return canonicalJson({ checker: FINAL_EVIDENCE_VERSION, contract: contract.key, font: unit.fontReference, materials });
}

/** Inspect every required source against the SAME final bytes. Saving is not approval. */
export async function inspectFinalArtwork(unit: ProductionUnit, source: SourceTaskRecord, url: string, ledger: ArtworkReviewLedger,
  selected?: ReviewCategory[], inspect = verifyArtworkModelEdits): Promise<ArtworkReviewLedger> {
  const extended = ledger as ArtworkReviewLedger & { evidenceVersion?: string; evidenceKey?: string };
  const items = ledger.items.filter(item => !['size', 'position'].includes(item.id) && (selected ? selected.includes(item.id)
    : !item.actor && (['pending', 'uncertain'].includes(item.status) || extended.evidenceVersion !== FINAL_EVIDENCE_VERSION)));
  if (!items.length) return ledger;
  const checks: ArtworkEditCheck[] = [];
  const models = new Set<string>(), hashes: string[] = [];
  const uncertain = (category: ReviewCategory, requirement: string, evidence: string): ArtworkEditCheck => ({
    category: category as ArtworkEditCheck['category'], requirement, status: 'uncertain', impact: 'unknown', evidence,
  });
  try {
    const final = await readProductionFile(url);
    if (sha(final) !== ledger.sha256) throw new Error('最终图片已变化，不能沿用此核对记录');
    const { selection, contract } = requirementInput(unit, source);
    const ids = [...new Set([selection.primary?.id, ...selection.referenceMaterialIds].filter((id): id is string => !!id))];
    for (const id of ids) {
      const material = source.materials.find(item => item.id === id)!;
      const label = `图${source.materials.findIndex(item => item.id === id) + 1}`;
      const roles = contract.inputs.find(item => item.sourceLabel === label)?.roles ?? ['reference'];
      const font = id === unit.fontReference?.materialId ? fontReferenceInput(source, unit) : undefined;
      const relevant = items.filter(item => roles.includes('content') || item.id === 'text' && (roles.includes('font') || !!font)
        || item.id === 'color' && roles.includes('color') || item.id === 'layout' && roles.includes('layout')
        || roles.includes('reference') && ['text', 'color', 'layout'].includes(item.id));
      if (!relevant.length) continue;
      try {
        if (!material.url) throw new Error('缺少可读取的原始素材');
        let original = await readProductionFile(material.url);
        if (font) original = await cropFontReference(original, font);
        hashes.push(sha(original));
        const requirements = relevant.map(item => [
          `【${item.label}】核对输入图1 = WPS ${label}${font ? '的指定字体裁片' : ''}；输入图2 = 当前完整最终图案。`,
          roles.includes('content') ? '图1提供本位置的成品内容。只核对它应贡献的内容，不因最终图包含其他内容素材或新增文字而误判。'
            : `图1仅提供${roles.map(role => roleLabels[role] ?? role).join('、')}参考，不要求复制它原有的文字、标志、衣服或背景。`,
          item.requirement, font ? fontReferenceRequirement(font, unit.exactText) : '',
          `本位置原文：${contract.scopedSource}`, `执行要求：${unit.instruction}\n${unit.layoutNote}`,
          `准确新增文字：${unit.exactText || '未指定新增文字，保留指定内容原图可辨文字'}`,
          '只评价当前这一项目。按明确要求处理背景、取材和局部改色；不是所有底色都应删除。看不清或证据不足记uncertain，不猜字、不替其他材料做判断。',
        ].filter(Boolean).join('\n'));
        const result = await inspect(original, final, requirements);
        if (result.outputSha256 !== ledger.sha256 || result.sourceSha256 !== sha(original) || result.checks.length !== relevant.length) throw new Error('核对回执的图片或项目数量不匹配');
        models.add(result.model);
        result.checks.forEach((check, i) => checks.push({ ...check, category: relevant[i].id as ArtworkEditCheck['category'], evidence: `[${label}] ${check.evidence}` }));
      } catch (error) {
        // An explicit earlier failure (e.g. 应白色，实际深蓝) must not be downgraded to
        // uncertain by a repeat check that could not run; only pending/uncertain verdicts soften.
        for (const item of relevant) checks.push(item.status === 'failed'
          ? { category: item.id as ArtworkEditCheck['category'], requirement: item.requirement, status: 'failed', impact: 'unknown', evidence: `${item.evidence}；复核未完成：${safeErrorText(error)}` }
          : uncertain(item.id, item.requirement, `[${label}] 本项核对未完成：${safeErrorText(error)}`));
      }
    }
    for (const issue of contract.issues) for (const item of items) checks.push(uncertain(item.id, item.requirement, issue.message));
    for (const item of items) if (!checks.some(check => check.category === item.id)) checks.push(uncertain(item.id, item.requirement, '没有对应的原始证据；不能以最终图片自证符合，请人工核对'));
    const verification: ArtworkEditVerification = { version: 'artwork-edit-check-v1', sourceSha256: hashes[0] ?? '',
      inputSha256: [...hashes, ledger.sha256], outputSha256: ledger.sha256, model: [...models].join(' / ') || 'unavailable',
      inspectionVersion: FINAL_EVIDENCE_VERSION, checks };
    const next = applyFinalArtworkReview(ledger, verification, items.map(item => item.id)) as typeof extended;
    next.evidenceVersion = FINAL_EVIDENCE_VERSION;
    next.evidenceKey = canonicalJson({ contract: contract.key, inputSha256: hashes, outputSha256: ledger.sha256 });
    return next;
  } catch (error) {
    const next = structuredClone(ledger);
    next.history.push({ sha256: ledger.sha256, at: ledger.updatedAt, items: ledger.items });
    next.updatedAt = new Date().toISOString();
    next.items = next.items.map(item => items.some(target => target.id === item.id) ? { ...item,
      status: item.status === 'failed' ? 'failed' : 'uncertain', evidence: `${item.evidence}；核对未完成：${safeErrorText(error)}` } : item);
    return next;
  }
}
