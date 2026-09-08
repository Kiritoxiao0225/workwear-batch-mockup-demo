import { compileGenerationPrompt } from '@/lib/artwork-generation-prompt';

/** Canonical image numbers are for matching only; the customer's source text stays intact. */
export function normalizeArtworkImageNumbers(text: string) {
  const digits = '零一二三四五六七八九';
  return text.normalize('NFKC').replace(/图(?:片)?\s*([0-9]+|[零一二三四五六七八九十]+)/gu, (label, ordinal: string) => {
    const parts = ordinal.split('十');
    const number = /^\d+$/u.test(ordinal) ? Number(ordinal) : parts.length === 2
      ? (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0)
      : digits.indexOf(ordinal);
    return number > 0 ? `图${number}` : label;
  });
}

export function artworkImageNumbers(text: string) {
  return [...normalizeArtworkImageNumbers(text).matchAll(/图(\d+)/gu)].map(match => Number(match[1]));
}

/** Longest aliases first; preserve the customer's original text outside matching. */
export const ARTWORK_PLACEMENT_ALIASES: Record<string, string> = {
  正面左胸: 'leftChest', 正面右胸: 'rightChest', 后背上方: 'back', 后领口: 'back',
  正前面: 'frontCenter', 正面: 'frontCenter', 左胸: 'leftChest', 右胸: 'rightChest',
  后脖: 'back', 后颈: 'back', 后领: 'back', 后背: 'back', 背面: 'back', 左袖: 'leftSleeve', 右袖: 'rightSleeve',
};

export function artworkPlacementFields(text: string) {
  return [...text.matchAll(new RegExp(`(${Object.keys(ARTWORK_PLACEMENT_ALIASES).join('|')}|字体|颜色|工艺|尺寸)\\s*(?:[:：]|\\s+(?=(?:使用|取用|用)?\\s*图)|(?=图))`, 'gu'))];
}

/** Explicit source crops are content constraints, never a whole-foreground default. */
export function artworkSourceSelections(text: string, imageNumber: number) {
  return [...normalizeArtworkImageNumbers(text).matchAll(/图(\d+)\s*(?:中|里)?(?:的)?\s*((?:前|后|第)[零一二三四五六七八九十0-9]+(?:排|行)|[上下左右]半(?:部(?:分)?|区)?)/gu)]
    .filter(match => Number(match[1]) === imageNumber)
    .map(match => ({ text: match[0].trim(), range: match[2] }));
}

/** Shared by analysis import, the plan editor and server-side plan saves. */
export function artworkPlanIssues(source: { requirementText: string; materials: Array<{ id: string }> }, plan: {
  materialId: string | null; referenceMaterialIds: string[]; instruction: string; layoutNote: string; generationPrompt?: string;
  sourceScope: string; placement: { key: string } | null;
}) {
  const primaryIndex = source.materials.findIndex(material => material.id === plan.materialId);
  const issues = primaryIndex < 0 ? ['主要内容素材未绑定或已不存在'] : [];
  if (!plan.instruction.trim()) issues.push('缺少制作要求');
  for (const id of plan.referenceMaterialIds) {
    if (!source.materials.some(material => material.id === id)) issues.push(`参考素材已不存在：${id}`);
    if (id === plan.materialId) issues.push('主要内容素材不能同时作为额外参考素材');
  }
  return [...new Set([...issues, ...artworkReferenceIssues({
    ...plan, sourceRequirementText: source.requirementText, printPlacement: plan.placement,
    primaryImageLabel: `图${primaryIndex + 1}`,
    referenceImages: plan.referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(material => material.id === id) + 1}` })),
  })])];
}

export type ArtworkReferenceEvidence = { number: number; role: 'layout' | 'style' | 'unknown'; attributes: Array<'layout' | 'font' | 'color'>; clause: string };

export function artworkReferenceCovers(actual: ArtworkReferenceEvidence, required: ArtworkReferenceEvidence) {
  return actual.number === required.number && (required.attributes.length
    ? required.attributes.every(attribute => actual.attributes.includes(attribute))
    : required.role === 'unknown' || actual.role === required.role);
}

/** A reference must be explicitly associated with an image, not just present in the attachments. */
export function artworkReferenceEvidence(text: string): ArtworkReferenceEvidence[] {
  return normalizeArtworkImageNumbers(text).replace(/(排版|字体|字形|颜色|配色)[，,]\s*(?=(?:排版|字体|字形|颜色|配色))/gu, '$1、').split(/[，,。；;\n]/u).flatMap(clause => {
    if (/(?:不要|无需|不需要|不得|禁止|不能|不再|不)\s*(?:参考|参照|按照|仿照)|不(?:作为|用作|作)参考/u.test(clause)) return [];
    const images = [...clause.matchAll(/图(\d+)/gu)];
    return images.flatMap((match, index) => {
      const before = clause.slice(index ? images[index - 1].index! + images[index - 1][0].length : 0, match.index);
      const after = clause.slice(match.index! + match[0].length, images[index + 1]?.index ?? clause.length);
      const forward = /(?:参考|参照|按照|仿照|依照|按)\s*$/u.test(before);
      const backward = /^[^图]{0,24}(?:参考|参照)(?!\s*$)/u.test(after)
        || /^[^图]{0,24}(?:参考|参照)\s*$/u.test(after) && index === images.length - 1;
      if (!forward && !backward) return [];
      const context = `${before}\n${after}`;
      const role = /(?:排版|版式|布局|构图|层级|比例|位置关系)/u.test(context) ? 'layout'
        : /(?:字体|字形|笔触|书法|风格|颜色|配色)/u.test(context) ? 'style' : 'unknown';
      const attributes: ArtworkReferenceEvidence['attributes'] = [];
      if (/(?:排版|版式|布局|构图|层级|比例|位置关系)/u.test(context)) attributes.push('layout');
      if (/(?:字体|字形|笔触|书法)/u.test(context)) attributes.push('font');
      if (/(?:颜色|配色|字色)/u.test(context)) attributes.push('color');
      return [{ number: Number(match[1]), role, attributes, clause: clause.trim() } satisfies ArtworkReferenceEvidence];
    });
  });
}

export function artworkReferenceIssues(input: { generationPrompt?: string; instruction: string; layoutNote: string; primaryImageLabel: string; referenceImages: Array<{ label: string }>; sourceRequirementText?: string; printPlacement?: { key: string } | null; sourceScope?: string }) {
  if (input.generationPrompt?.trim()) {
    try {
      compileGenerationPrompt(input.generationPrompt, [
        { sourceLabel: input.primaryImageLabel, modelInputLabel: '图1', role: 'content' },
        ...input.referenceImages.map((image, index) => ({ sourceLabel: image.label, modelInputLabel: `图${index + 2}`, role: 'reference' as const })),
      ]);
      const primaryNumber = artworkImageNumbers(input.primaryImageLabel)[0] ?? 0;
      const scoped = input.sourceRequirementText ? sourceArtworkReferenceRequirement(input.sourceRequirementText, input.printPlacement?.key ?? null, primaryNumber) : '';
      const bound = new Set(input.referenceImages.map(image => normalizeArtworkImageNumbers(image.label)));
      const issues = artworkReferenceEvidence(scoped).filter(reference => reference.number !== primaryNumber && !bound.has(`图${reference.number}`))
        .map(reference => `原文要求参考图${reference.number}，当前方案未绑定该素材`);
      if (artworkSourceSelections(scoped, primaryNumber).length && input.sourceScope && input.sourceScope !== 'custom') issues.push('原文限定局部取材，请将素材取用设为“按描述取用”');
      return [...new Set(issues)];
    } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  }
  const evidence = artworkReferenceEvidence(`${input.instruction}\n${input.layoutNote}`);
  const primary = normalizeArtworkImageNumbers(input.primaryImageLabel);
  const bound = new Set(input.referenceImages.map(image => normalizeArtworkImageNumbers(image.label)));
  const issues: string[] = [];
  const primaryNumber = artworkImageNumbers(primary)[0] ?? 0;
  const scoped = input.sourceRequirementText ? sourceArtworkReferenceRequirement(input.sourceRequirementText, input.printPlacement?.key ?? null, primaryNumber) : '';
  const original = artworkReferenceEvidence(scoped);
  if (input.sourceRequirementText) {
    const allSourceReferences = artworkReferenceEvidence(input.sourceRequirementText);
    for (const label of bound) {
      const number = artworkImageNumbers(label)[0];
      if (label === primary) continue;
      if (allSourceReferences.some(item => item.number === number) && !original.some(item => item.number === number)) {
        issues.push(`${label}已绑定，但原文中的参考要求未能对应到当前印花位置，请核对图号与位置归属`);
      } else if (!original.some(item => item.number === number) && !evidence.some(item => item.number === number)) {
        issues.push(`${label}已绑定为参考，但制作要求没有说明其用途，请核对后补充或取消该引用`);
      }
    }
  }
  for (const reference of original) {
    if (`图${reference.number}` === primary) continue;
    if (!bound.has(`图${reference.number}`)) issues.push(`原文要求参考图${reference.number}，当前方案未绑定该素材`);
    if (!evidence.some(item => artworkReferenceCovers(item, reference))) {
      issues.push(`原文中图${reference.number}的参考要求未完整保留，请修正制作要求`);
    }
  }
  for (const number of new Set(evidence.map(item => item.number))) {
    const label = `图${number}`;
    if (label === primary) continue;
    if (!bound.has(label)) issues.push(`制作要求引用${label}，但未绑定对应参考素材`);
    if (evidence.filter(item => item.number === number).every(item => item.role === 'unknown')) {
      issues.push(`${label}的参考用途尚未明确，请在“修改要求”中注明参考区域，以及字体、颜色或排版；看不清时保留待核对`);
    }
  }
  const selections = artworkSourceSelections(scoped, primaryNumber);
  const actualSelections = artworkSourceSelections(input.instruction, primaryNumber);
  for (const selection of selections) {
    const canonicalRange = (value: string) => normalizeArtworkImageNumbers(`图${value.replace(/^(前|后|第)/u, '').replace(/[排行]$/u, '')}`) + value[0];
    if (!actualSelections.some(actual => actual.range === selection.range || /[排行]$/u.test(actual.range) && /[排行]$/u.test(selection.range) && canonicalRange(actual.range) === canonicalRange(selection.range))) {
      issues.push(`原文限定取用“${selection.text}”，制作要求未完整保留该范围`);
    }
    if (input.sourceScope && input.sourceScope !== 'custom') issues.push(`原文限定取用“${selection.text}”，请将素材取用设为“按描述取用”`);
  }
  return [...new Set(issues)];
}

/** Scope source evidence to this position and garment branch before repairing an AI omission. */
export function sourceArtworkReferenceRequirement(source: string, placement: string | null, primaryImageNumber: number) {
  if (!primaryImageNumber) return '';
  const text = normalizeArtworkImageNumbers(source);
  const fields = artworkPlacementFields(text);
  const sections = fields.length ? fields.flatMap((field, index) => {
    const key = ARTWORK_PLACEMENT_ALIASES[field[1]];
    return key === placement ? [text.slice(field.index! + field[0].length, fields[index + 1]?.index ?? text.length)] : [];
  }) : [text];
  return sections.flatMap(section => {
    // For example: 左胸：冲锋衣：图一  POLO衫：研+图5+2026【参考图四】.
    const headers = [...section.matchAll(/[\p{L}\p{N}-]+\s*[:：]/gu)];
    const branches = headers.length
      ? [section.slice(0, headers[0].index), ...headers.map((header, index) => section.slice(header.index! + header[0].length, headers[index + 1]?.index ?? section.length))]
      : [section];
    return branches.filter(branch => {
      const references = new Set(artworkReferenceEvidence(branch).map(item => item.number));
      return artworkImageNumbers(branch).some(number => number === primaryImageNumber && !references.has(number));
    });
  }).join('\n');
}
