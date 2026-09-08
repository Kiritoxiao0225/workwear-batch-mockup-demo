import { artworkIntent, describeArtworkComposition } from '@/lib/task-review-artwork';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import { ARTWORK_METHODS, ARTWORK_ROUTING_STANDARD, decideArtworkMethod, type ArtworkRoutingDecision } from '@/lib/artwork-routing-standard';
import { artworkRequirementFacts } from '@/lib/artwork-routing-request';
import { artworkBlockingAmbiguities, artworkProcessingRoute } from '@/lib/task-review-analysis';

/** Use the same request classifier as the processing endpoint; historical native scores remain unverified. */
export function productionArtworkRouting(unit: ProductionUnit, source: SourceTaskRecord) {
  const primaryIndex = source.materials.findIndex(material => material.id === unit.materialId);
  const actual = unit.artwork?.recipeFingerprint === unit.recipeFingerprint ? unit.artwork.draft?.preprocessing : undefined;
  const report = actual?.routingReport;
  const facts = artworkRequirementFacts({ generationPrompt: unit.generationPrompt, instruction: unit.instruction, layoutNote: unit.layoutNote,
    sourceRequirementText: source.requirementText, printPlacement: unit.placement ?? undefined,
    artworkMethod: unit.artworkMethod,
    exactText: unit.textMode === 'replace' ? unit.exactText : '', sourceScope: unit.sourceScope,
    processingRoute: unit.route === 'deterministic' ? 'fidelity' : unit.route === 'blocked' || unit.route === 'gpt-image-2' ? 'auto' : unit.route,
    primaryImageLabel: `图${primaryIndex + 1}`, referenceImages: unit.referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(material => material.id === id) + 1}` })) });
  const sourceMaterial = source.materials[primaryIndex];
  facts.sourcePresent = Boolean(sourceMaterial && (sourceMaterial.url || sourceMaterial.previewUrl));
  facts.blockers.push(...artworkBlockingAmbiguities(unit.ambiguities),
    ...unit.referenceMaterialIds.filter(id => !source.materials.some(material => material.id === id && (material.url || material.previewUrl))).map(id => `缺少参考素材 ${id}`),
    ...(artworkProcessingRoute(unit) === 'blocked' ? ['制作要求尚待补充'] : []));
  if (facts.intent !== 'generate' && unit.textMode === 'replace' && !unit.exactText.trim()) { facts.intent = 'compose'; facts.editSpecification = 'incomplete'; }
  if (report && !facts.blockers.length && (report.source.protocol !== ARTWORK_ROUTING_STANDARD.scoreProtocol || report.graphic.protocol !== ARTWORK_ROUTING_STANDARD.scoreProtocol)) {
    const decision: ArtworkRoutingDecision = {
      version: ARTWORK_ROUTING_STANDARD.version, method: null, state: 'pending', action: 'inspect', checks: [],
      reason: '历史处理采用了错误的评分方向，不能继续作为当前推荐依据；当前图案可单独重新检测画质。',
    };
    return { facts, decision, historicalClarity: null, report };
  }
  facts.sourceClarity = report?.source ?? (typeof actual?.blurScore === 'number' ? { score: actual.blurScore, protocol: 'legacy-source-native' } : null);
  facts.requiredScale = report?.source.requiredScale ?? actual?.requiredScale ?? null;
  facts.repair = report ? { attempts: report.repair ? 1 : 0, clarity: report.repair, requiredScale: report.repair?.requiredScale ?? null }
    : { attempts: actual && actual.enhancement !== 'none' ? 1 : 0, clarity: null, requiredScale: null };
  if (report) facts.redrawEligibility = report.facts.redrawEligibility;
  return { facts, decision: decideArtworkMethod(facts), historicalClarity: report ? null : actual?.blurScore ?? null, report };
}

export function productionRecipe(unit: ProductionUnit, source: SourceTaskRecord) {
  unit = { ...unit, route: artworkProcessingRoute(unit) };
  const primaryIndex = source.materials.findIndex(material => material.id === unit.materialId);
  const input = { instruction: unit.instruction, exactText: unit.textMode === 'replace' ? unit.exactText : '', layoutNote: unit.layoutNote,
    primaryImageLabel: primaryIndex < 0 ? '待选择的主要素材' : `图${primaryIndex + 1}`,
    referenceImageLabels: unit.referenceMaterialIds.map(id => { const index = source.materials.findIndex(material => material.id === id); return index < 0 ? `缺失参考素材 ${id}` : `图${index + 1}`; }),
  };
  const composition = describeArtworkComposition(input);
  const intent = artworkIntent({ ...input, referenceImages: input.referenceImageLabels.map(label => ({ label })) });
  const textNeedsModel = (intent.hasStyleReference || intent.specialTypography) && input.exactText.length > 0;
  const currentRouting = productionArtworkRouting({ ...unit, artwork: null }, source);
  const needsReview = currentRouting.decision.state === 'review';
  const completeModel = currentRouting.facts.intent === 'generate';
  const hybrid = currentRouting.facts.intent === 'compose' && textNeedsModel;
  const preservation = unit.sourceScope === 'wholeImage' ? '保留整图与原底色' : '保留 Logo 图形并去底';
  const title = needsReview ? '先核对参考与制作要求' : unit.route === 'blocked' ? '先补充图案要求' : unit.route === 'gpt-image-2' ? 'GPT Image 2 生成完整透明 Logo'
    : completeModel ? '模型生成完整图案' : hybrid ? '保真主体＋模型文字'
    : `${preservation}＋必要时增强${input.exactText ? '＋准确文字组合' : ''}`;
  const reason = needsReview ? currentRouting.facts.blockers.join('；') || currentRouting.decision.reason : unit.route === 'blocked' ? unit.ambiguities.join('；') || '请先确认主要素材和制作要求。' : unit.route === 'gpt-image-2' ? '人工指定 GPT Image 2；规格 1K / Low / 透明 PNG。'
    : completeModel ? unit.generationPrompt ? '按已保存的生图提示词与对应素材生成白底图，再抠图。' : unit.route === 'model' ? '人工指定完整模型生成。' : intent.wholeCompositionReference ? '参考图决定整体字形、构图或排版，主要图与参考图一起交给模型。' : '需要从素材中取指定局部或组合参考图，由模型制作完整候选。'
    : hybrid ? '主体图形保真处理，特殊字形交给模型，再组合成完整图案。'
    : `${preservation}；增强等级须检测原图后确定。${unit.route === 'deterministic' ? '已手动指定保真处理，不自动改为模型重绘。' : '最多保真修复一次，复测仍不达标且符合纯色重绘条件才转 B。'}`;
  const components = completeModel || unit.route === 'gpt-image-2'
    ? [ `${input.primaryImageLabel}：进入成品的内容源`, ...composition.textSegments.map(text => `准确文字：${text}`),
      ...input.referenceImageLabels.map(label => `${label}：仅作参考，不复制背景`), '一次生成一个完整候选，再核对文字与图形' ]
    : composition.summary;
  const actual = unit.artwork?.draft?.preprocessing;
  const completedAttempt = [...unit.attempts].reverse().find(attempt => attempt.recipeFingerprint === unit.artwork?.recipeFingerprint && attempt.status === 'completed' && attempt.service !== 'manual-upload');
  return { title, reason, components, actual, actualLabel: actual?.routingReport ? `${ARTWORK_METHODS[actual.routingReport.executedMethod].code} ${ARTWORK_METHODS[actual.routingReport.executedMethod].label}${actual.routingReport.model ? ` · ${actual.routingReport.model}` : ''}` : actual?.processingRoute === 'model' ? `模型生成${actual.generationModel ? ` · ${actual.generationModel}` : ''}`
    : actual?.processingRoute === 'hybrid' ? '混合处理' : actual?.processingRoute === 'fidelity' ? `${actual.enhancement === 'professional' ? 'Professional 保真增强' : actual.enhancement === 'standard' ? 'Standard 增强' : '保留原像素'}＋${actual.backgroundRemoval === 'edge-connected' ? '本地边缘连通去底' : actual.backgroundRemoval === 'none' ? '无需去底' : actual.backgroundRemoval === 'product' ? '火山商品抠图' : '火山通用抠图'}${input.exactText ? '＋文字组合' : ''}` : completedAttempt?.service === 'gpt-image-2' ? 'GPT Image 2 生成' : null };
}
