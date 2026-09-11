import { fontReferenceInput, fontReferenceRequirement } from '@/lib/artwork-font-reference';
import { cropFontReference } from './artwork-font-reference';
import { createHash } from 'node:crypto';
import { applyFinalArtworkReview, type ArtworkReviewLedger, type ReviewCategory } from '@/lib/artwork-review-ledger';
import { artworkInputSelection } from '@/lib/artwork-reference';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import { readProductionFile } from './production-storage';
import { verifyArtworkModelEdits } from './artwork-content-inspection';

/** One final-image check, no generation, scoring, or implicit retry on page reads. */
export async function inspectFinalArtwork(unit: ProductionUnit, source: SourceTaskRecord, url: string, ledger: ArtworkReviewLedger,
  selected?: ReviewCategory[], inspect = verifyArtworkModelEdits): Promise<ArtworkReviewLedger> {
  const items = ledger.items.filter(item => !['size', 'position'].includes(item.id) && (selected ? selected.includes(item.id) : ['pending', 'uncertain'].includes(item.status)));
  if (!items.length) return ledger;
  try {
    const selection = artworkInputSelection(source, unit);
    const originalUrl = selection.primary?.url ?? selection.primary?.previewUrl;
    // Without original evidence, do not pretend a self-comparison proves conformity.
    if (!originalUrl) throw new Error('没有可对照的原始素材，请人工核对');
    const [original, final] = await Promise.all([readProductionFile(originalUrl), readProductionFile(url)]);
    if (createHash('sha256').update(final).digest('hex') !== ledger.sha256) throw new Error('最终图片已变化');
    const role = selection.primaryImageRole === 'reference' ? '图1仅作样式参考，不复制其原文字或图形。' : `图1为客户原始素材 ${selection.primaryImageLabel}，只核对本位置指定区域。`;
    const requirements = items.map(item => `【${item.label}】${role} 图2是已经完成所有删字、加字、改色、抠图、排版的最终图案。${item.requirement}。完整要求：${unit.instruction}\n${unit.layoutNote}\n明确文字：${unit.exactText || '以指定原图为准'}。明确要求优先于原图；原图白色前景和强调色必须保留。请列出具体位置、当前情况、预期及修正办法。看不清记 uncertain，不猜字，不以缺少几何测量为错版，不用中间步骤的限制判断最终图。`);
    const result = await inspect(original, final, requirements);
    // Text/font checks must compare with the designated font, not the chest Logo.
    const textIndex = items.findIndex(item => item.id === 'text');
    if (unit.fontReference && textIndex >= 0) {
      const reference = fontReferenceInput(source, unit)!;
      const material = source.materials.find(item => item.id === unit.fontReference!.materialId)!;
      const referenceUrl = material.url ?? material.previewUrl;
      if (!referenceUrl) throw new Error('字体参考图片不可读取');
      const bytes = await cropFontReference(await readProductionFile(referenceUrl), reference);
      const fontCheck = await inspect(bytes, final, [`图1是指定的字体参考区域，图2是最终图案。核对准确目标文字和笔画粗细、字形宽窄、收笔等是否符合参考。${fontReferenceRequirement(reference, unit.exactText)} 本次核对输入图号以上句为准；看不清记 uncertain。`]);
      if (fontCheck.outputSha256 !== ledger.sha256 || fontCheck.checks.length !== 1) throw new Error('字体核对没有对应当前最终图案');
      result.checks[textIndex] = { ...fontCheck.checks[0], category: 'text' };
    }
    if (result.checks.length !== items.length) throw new Error('核对项目不完整');
    // The inspector returns checks in requirement order. Bind to our selected category, not its guess.
    result.checks = result.checks.map((check, index) => ({ ...check, category: items[index].id as 'text' | 'color' | 'structure' | 'layout' | 'background' }));
    return applyFinalArtworkReview(ledger, result, items.map(item => item.id));
  } catch (error) {
    const next = structuredClone(ledger);
    next.history.push({ sha256: ledger.sha256, at: ledger.updatedAt, items: ledger.items });
    next.updatedAt = new Date().toISOString();
    next.items = next.items.map(item => items.some(target => target.id === item.id) ? { ...item,
      status: item.status === 'failed' ? 'failed' : 'uncertain',
      evidence: `${item.evidence}；本次核对未完成：${error instanceof Error ? error.message : String(error)}` } : item);
    return next;
  }
}
