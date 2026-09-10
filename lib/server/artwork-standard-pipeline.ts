import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createHybridArtworkDraft, createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { ARTWORK_ROUTING_STANDARD, artworkQualityPassed, decideArtworkMethod, type ArtworkMethod, type ArtworkQualityMeasurement, type ArtworkRoutingReport } from '@/lib/artwork-routing-standard';
import { artworkEditColor, artworkRequirementFacts, standardArtworkPrompts, resolvedFlatLogoRedrawPrompt, artworkPromptHash } from '@/lib/artwork-routing-request';
import { assessArtworkResolution, artworkDraftFromPreparedGraphic, artworkIntent, buildArtworkComponentPlan, type ArtworkPreparationRequest, type ArtworkPreparationResponse, type ArtworkQualityEvaluation, type ArtworkRouteDecision } from '@/lib/task-review-artwork';
import { inspectArtworkSource, assertUsableArtworkMask, alphaMaskReport, createArtworkRecolorMask } from '@/lib/server/artwork-image-processing';
import { artworkSha256, measureArtworkQuality } from '@/lib/server/artwork-quality';
import { prepareTaskArtwork } from '@/lib/server/media-kit-artwork';
import { cleanFlatLogo, flatLogoRedrawInput } from '@/lib/server/flat-logo-cleanup';
import { generateStandardArtwork, inspectRedrawSource, redrawEligibility } from '@/lib/server/ark-artwork-processing';
import { saveArtworkRoutingReport, saveArtworkRunImage, saveArtworkGenerationReceipt } from '@/lib/server/artwork-routing-records';
import type { NativeArtworkCandidate } from '@/lib/task-review-artwork';
import type { ArtworkCutoutMode, ArtworkCutoutReceipt, ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { cutoutArtworkForPipeline, ArtworkCutoutPendingError } from './artwork-cutout';
import type { ArtworkProgressEvent, ArtworkTiming } from '@/lib/artwork-progress';
import { artworkReferenceColors, type ArtworkReferenceColorReceipt } from '@/lib/artwork-reference-color';
import { resolveArtworkReferenceColor } from './artwork-reference-color';
import { artworkModelEdits, type ArtworkEditVerification } from '@/lib/artwork-model-edits';
import { verifyArtworkModelEdits } from './artwork-content-inspection';

async function routedCutout(bytes: Buffer, options: { scene?: 'product' | 'general'; crop?: boolean; mode?: ArtworkCutoutMode } = {}) {
  return (await cutoutArtworkForPipeline(bytes, options.mode)).bytes;
}

export class NativeArtworkCandidateError extends Error {
  constructor(public candidate: NativeArtworkCandidate) { super(candidate.reason); }
}

export const standardArtworkServices = {
  measure: measureArtworkQuality,
  fidelity: prepareTaskArtwork,
  generate: generateStandardArtwork,
  inspect: inspectRedrawSource,
  cutout: routedCutout,
  saveReport: saveArtworkRoutingReport,
  saveImage: saveArtworkRunImage,
  saveGeneration: saveArtworkGenerationReceipt,
  resolveReferenceColor: resolveArtworkReferenceColor,
  verifyEdits: verifyArtworkModelEdits,
};
export type StandardArtworkServices = typeof standardArtworkServices;
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const bytesFromDataUrl = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const evaluation = (quality: ArtworkQualityMeasurement): ArtworkQualityEvaluation => ({ blur: quality.rawBlur ?? 100 - quality.score, vqscore: quality.vqscore, noise: quality.noise, compressionArtifacts: quality.compressionArtifacts });

async function generatedCutout(bytes: Buffer, services: StandardArtworkServices) {
  const cutout = await services.cutout(bytes);
  assertUsableArtworkMask(await alphaMaskReport(cutout));
  return cutout;
}

/** One repair and at most one faithful redraw. Failed quality never triggers an unbounded retry. */
export async function prepareStandardArtwork(request: ArtworkPreparationRequest, services: StandardArtworkServices = standardArtworkServices, onProgress?: (event: ArtworkProgressEvent) => void): Promise<ArtworkPreparationResponse> {
  const started = performance.now();
  const timings: ArtworkTiming[] = [];
  const progress = (message: string, generationFinished = false) => onProgress?.({ type: 'progress', message, generationFinished });
  async function timed<T>(stage: string, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let status: ArtworkTiming['status'] = 'failed';
    try { const result = await task(); status = 'completed'; return result; }
    finally {
      const timing = { stage, startMs: Math.round(start - started), durationMs: Math.round(performance.now() - start), status };
      timings.push(timing); onProgress?.({ type: 'timing', timing });
    }
  }
  async function preview(bytes: Buffer, label: string) {
    if (!onProgress) return;
    // Only a small view-only thumbnail travels early; final pixels use the normal save contract.
    try {
      const thumbnail = await sharp(bytes).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      onProgress({ type: 'preview', url: dataUrl(thumbnail), label });
    } catch { /* A display-only thumbnail cannot invalidate a saved model original. */ }
  }
  let cutoutReceipt: ArtworkCutoutReceipt | undefined;
  const cutoutRuns: ArtworkCutoutReceipt[] = [];
  const originalCutout = services.cutout;
  services = { ...services, cutout: async (bytes, options) => {
    if (originalCutout !== routedCutout) return originalCutout(bytes, options);
    const result = await cutoutArtworkForPipeline(bytes, request.cutoutMode);
    cutoutReceipt = result.receipt;
    cutoutRuns.push(result.receipt);
    return result.bytes;
  } };
  const underlying = services;
  let measurements = 0;
  services = { ...underlying,
    measure: bytes => timed(measurements++ === 0 ? 'sourceQuality' : 'resultQuality', () => underlying.measure(bytes)),
    generate: (...args) => timed('generation', () => underlying.generate(...args)),
    cutout: (...args) => timed('cutout', () => underlying.cutout(...args)),
    fidelity: (...args) => timed('fidelity', () => underlying.fidelity(...args)),
    inspect: (...args) => timed('inspection', () => underlying.inspect(...args)),
  };
  const prompts = standardArtworkPrompts(request);
  if (request.expectedPromptVersion && request.expectedPromptVersion !== prompts.version) throw new Error('页面制作要求版本已过期，请刷新后重试');
  if (request.expectedPromptHash && request.expectedPromptHash !== prompts.hash) throw new Error('页面显示的制作要求与服务端不一致，已停止处理');
  const facts = artworkRequirementFacts(request);
  const modelEdits = request.primaryImageRole === 'reference' ? [] : artworkModelEdits(request);
  let decision = decideArtworkMethod(facts);
  if (decision.state === 'review') throw new Error(`${decision.reason} ${facts.blockers.join('；')}`);
  if (decision.method === 'generate' && !request.generationPrompt?.trim()) throw new Error('请先整理生图提示词，再制作图案');
  const colorReferences = artworkReferenceColors(request);
  let referenceColor: ArtworkReferenceColorReceipt | undefined;
  if (facts.intent === 'compose' && colorReferences.length) {
    if (colorReferences.length !== 1) throw new Error('当前图案指定了多个参考色，请分别明确改色对象和色号，或选择整图生成');
    progress(`正在从${colorReferences[0].label}的指定部位识别参考色…`);
    referenceColor = await timed('referenceColor', () => services.resolveReferenceColor(request, colorReferences[0]));
  }
  const intent = artworkIntent(request);
  if (facts.intent === 'compose' && (intent.hasStyleReference || intent.specialTypography)
    && (prompts.styledTexts.length > 2 || prompts.styledTexts.some(text => text.text.length > 40))) throw new Error('特殊文字单次最多 2 个组件、每个 40 字，请先拆分要求或提供字体素材');
  const sourceBytes = bytesFromDataUrl(request.image.dataUrl);
  const sourceProfile = await inspectArtworkSource(sourceBytes);
  const runId = randomUUID();
  const operations: string[] = [];
  if (referenceColor) operations.push(`参考${referenceColor.label}取色 ${referenceColor.hex}：${referenceColor.description}`);
  const needsSubjectCutout = decision.method !== 'generate' && request.sourceScope !== 'wholeImage';
  const measuredSource = needsSubjectCutout ? await services.cutout(sourceBytes) : sourceBytes;
  if (needsSubjectCutout) {
    assertUsableArtworkMask(await alphaMaskReport(measuredSource));
    await services.saveImage(runId, 'source-cutout-for-measurement', measuredSource);
    operations.push('按抠图方式提取主体，不增强；按可见主体测量');
  }
  let earlyGenerated: Awaited<ReturnType<StandardArtworkServices['generate']>> | undefined;
  let source: ArtworkQualityMeasurement;
  if (decision.method === 'generate') {
    // D's route is fixed by the validated requirements, not by source clarity.
    // Await both outcomes so a scoring failure cannot abandon a paid generation.
    progress('正在生成完整图案…');
    const results = await Promise.allSettled([
      services.measure(measuredSource),
      (async () => {
        const images = prompts.imageMapping.map(mapping => mapping.sourceLabel === request.primaryImageLabel ? request.image.dataUrl : request.referenceImages.find(reference => reference.label === mapping.sourceLabel)!.image.dataUrl);
        const generated = await services.generate(prompts.generate, images, { background: 'auto' });
        await services.saveImage(runId, 'generated-original', generated.bytes);
        progress('图案已生成，正在处理透明背景…', true);
        await preview(generated.bytes, '模型候选预览 · 待抠图与检查，尚未保存');
        return generated;
      })(),
    ]);
    if (results[1].status === 'rejected') throw results[1].reason;
    earlyGenerated = results[1].value;
    if (results[0].status === 'rejected') {
      const reason = `图案已生成，但原图评分未完成：${String(results[0].reason)}。已保留模型原图，尚未保存成品。`;
      await services.saveGeneration(runId, { runId, model: earlyGenerated.model, status: 'needs-review', reason, timings, metadata: earlyGenerated.generationMetadata });
      throw new NativeArtworkCandidateError({ runId, url: dataUrl(earlyGenerated.bytes), model: earlyGenerated.model, reason, promptHash: artworkPromptHash(prompts.generate) });
    }
    source = results[0].value;
  } else {
    progress('正在检查原图并处理图案…');
    source = await services.measure(measuredSource);
  }
  facts.sourceClarity = source;
  facts.requiredScale = source.requiredScale;
  decision = decideArtworkMethod(facts);
  operations.push('原图统一口径评分');
  const reviewReasons: string[] = [];
  let repair: ArtworkQualityMeasurement | null = null;
  let graphic: Buffer;
  let graphicQuality: ArtworkQualityMeasurement;
  let graphicMethod: ArtworkMethod = 'preserve';
  let model: string | null = null;
  let usedPrompt: string | null = null;
  let enhancement: 'none' | 'standard' | 'professional' = 'none';
  let edgeRefinement: string | undefined;
  let redraw: ArtworkRoutingReport['redraw'];
  let backgroundRemoval: ArtworkPreparationResponse['preprocessing']['backgroundRemoval'] = 'none';
  const graphicFacts = { ...facts, intent: 'preserve' as const, intentReason: '保留主要素材的原设计', blockers: [] };
  let graphicDecision = decideArtworkMethod(graphicFacts);

  if (decision.method === 'generate') {
    usedPrompt = prompts.generate;
    const generated = earlyGenerated!;
    if (generated.generationNote) operations.push(generated.generationNote);
    const metadata = await sharp(generated.bytes).metadata();
    const originalMask = await alphaMaskReport(generated.bytes);
    let mask = originalMask;
    graphic = generated.bytes;
    let cutoutFailure = '';
    let pendingCutout: ArtworkCutoutResult | undefined;
    try {
      // Keep the full model layout, including detached lettering, on its original canvas.
      graphic = await services.cutout(generated.bytes, { scene: 'product', crop: false });
      const preparedMetadata = await sharp(graphic).metadata();
      if (preparedMetadata.format !== 'png' || !preparedMetadata.hasAlpha) throw new Error('抠图结果不是带透明通道的 PNG');
      mask = await alphaMaskReport(graphic);
      assertUsableArtworkMask(mask);
      backgroundRemoval = 'product';
      progress('透明背景已处理，正在检查成品清晰度…');
      await preview(graphic, '透明图案预览 · 待质量检查，尚未保存');
      operations.push('整图生成后按抠图方式分流；保留模型字体、颜色与排版，不重新排字');
    } catch (error) {
      if (error instanceof ArtworkCutoutPendingError) pendingCutout = error.result;
      cutoutFailure = `图案已生成，但抠图未完成：${error instanceof Error ? error.message : String(error)}。已保留模型原图供下载，未作为成品上衣。`;
    }
    let editVerification: ArtworkEditVerification | undefined;
    let editFailure = '';
    if (!cutoutFailure && modelEdits.length) {
      progress('正在逐项核对指定区域的改色与保留内容…');
      try {
        editVerification = await timed('editVerification', () => services.verifyEdits(sourceBytes, graphic,
          [...modelEdits, '未点名修改的原有文字、字形、数字、装饰、配色及相对排版保持原样；无关来源水印与外围背景除外']));
        const issues = editVerification.checks.filter(check => check.status !== 'passed');
        if (issues.length) editFailure = `修改要求尚未通过核对：${issues.map(check => `${check.requirement}：${check.evidence}`).join('；')}`;
      } catch (error) { editFailure = `修改要求核对未完成：${error instanceof Error ? error.message : String(error)}`; }
    }
    await services.saveGeneration(runId, { runId, model: generated.model, prompt: usedPrompt, promptHash: artworkPromptHash(usedPrompt), imageMapping: prompts.imageMapping,
      sourceSha256: artworkSha256(sourceBytes), originalSha256: artworkSha256(generated.bytes), metadata: generated.generationMetadata,
      width: metadata.width, height: metadata.height, originalHasAlpha: metadata.hasAlpha, originalMask, mask, backgroundRemoval,
      editVerification, status: cutoutFailure || editFailure ? 'needs-review' : 'cutout-accepted', reason: cutoutFailure || editFailure, timings: [...timings] });
    if (cutoutFailure) throw new NativeArtworkCandidateError({ runId, url: dataUrl(generated.bytes), model: generated.model, reason: cutoutFailure,
      promptHash: artworkPromptHash(usedPrompt), cutout: pendingCutout, requiresEditVerification: modelEdits.length > 0 });
    if (editFailure) {
      await services.saveImage(runId, 'edit-review-candidate', graphic);
      throw new NativeArtworkCandidateError({ runId, url: dataUrl(graphic), model: generated.model, stage: 'edit-review',
        reason: `${editFailure}。已保留实际候选供对比，尚未作为成品保存，不自动重新生图。`, promptHash: artworkPromptHash(usedPrompt) });
    }
    if (editVerification) operations.push('已逐项核对指定改色及其余图案保留要求');
    model = generated.model;
    graphicMethod = 'generate';
    graphicQuality = await services.measure(graphic);
    operations.push('D 白底整图生成 1 次', '抠图后真实 Alpha 检查通过', '抠图后统一口径评分');
    graphicDecision = decision;
  } else {
    const runFidelity = async (mode: 'none' | 'professional') => {
      const prepared = await services.fidelity({ ...request,
        ...(needsSubjectCutout ? { image: { ...request.image, dataUrl: dataUrl(measuredSource), mimeType: 'image/png' as const } } : {}),
        artworkMethod: undefined, exactText: '', layoutNote: '', referenceImages: [], processingRoute: 'fidelity', enhancementMode: mode }, { measuredQuality: evaluation(source) });
      const bytes = bytesFromDataUrl(prepared.draft.graphic.sourceUrl);
      backgroundRemoval = prepared.preprocessing.backgroundRemoval;
      edgeRefinement = prepared.preprocessing.edgeRefinement;
      return { bytes, measured: await services.measure(bytes), enhancement: prepared.preprocessing.enhancement };
    };
    let prepared = await runFidelity(graphicDecision.action === 'repair-once' ? 'professional' : 'none');
    enhancement = prepared.enhancement;
    // Cutting out an initially usable source can itself expose edge defects.
    if (enhancement === 'none' && !artworkQualityPassed(prepared.measured)) prepared = await runFidelity('professional');
    enhancement = prepared.enhancement;
    graphic = prepared.bytes;
    graphicQuality = prepared.measured;
    operations.push(enhancement === 'none' ? 'A 原图去底' : 'A 保真修复 1 次', '处理后统一口径评分');
    if (edgeRefinement) operations.push(edgeRefinement);
    if (enhancement !== 'none') {
      repair = graphicQuality;
      graphicFacts.repair = { attempts: 1, clarity: repair, requiredScale: repair.requiredScale };
      facts.repair = graphicFacts.repair;
    }
    graphicDecision = decideArtworkMethod(graphicFacts);
    if (!artworkQualityPassed(graphicQuality) && !facts.strictPreservation) {
      try {
        const inspection = await services.inspect(request.image.dataUrl);
        graphicFacts.redrawEligibility = redrawEligibility(inspection);
        facts.redrawEligibility = graphicFacts.redrawEligibility;
        operations.push(`重绘类型检查：${inspection.type}；${inspection.reasons.join('；')}`);
        graphicDecision = decideArtworkMethod(graphicFacts);
        if (graphicDecision.action === 'redraw') {
          const redrawInput = await flatLogoRedrawInput(needsSubjectCutout ? measuredSource : sourceBytes);
          const palette = redrawInput.palette;
          await services.saveImage(runId, 'redraw-input', redrawInput.bytes);
          operations.push(`按可见主体安全裁剪为 ${redrawInput.bounds.width}×${redrawInput.bounds.height}px，PNG 输入，不放大`);
          operations.push(`原图主色校验：${palette.length} 种，实色覆盖 ≥95%`);
          usedPrompt = resolvedFlatLogoRedrawPrompt(prompts.redraw, { palette, recognizedText: inspection.recognizedText, structureDescription: inspection.structureDescription });
          redraw = { status: 'failed', stage: 'generation', model: null, inputSha256: artworkSha256(redrawInput.bytes), promptHash: artworkPromptHash(usedPrompt) };
          const generated = await services.generate(usedPrompt, [dataUrl(redrawInput.bytes)]);
          if (generated.generationNote) operations.push(generated.generationNote);
          redraw.model = generated.model;
          redraw.stage = 'cleanup';
          await services.saveImage(runId, 'redraw-original', generated.bytes);
          const cleaned = await cleanFlatLogo(await services.cutout(generated.bytes), palette);
          assertUsableArtworkMask(await alphaMaskReport(cleaned));
          redraw.stage = 'measurement';
          const measured = await services.measure(cleaned);
          graphic = cleaned;
          graphicQuality = measured;
          model = generated.model;
          graphicMethod = 'redraw';
          edgeRefinement = undefined;
          backgroundRemoval = 'edge-connected';
          redraw.status = 'completed';
          operations.push('B 高清重绘 1 次', '按主色分区净化、去杂点与透明边缘处理（flat-logo-cleanup-v2）', '重绘后统一口径评分');
        }
      } catch (error) {
        if (error instanceof ArtworkCutoutPendingError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (redraw) redraw.error = reason;
        reviewReasons.push(`高清重绘未完成：${reason}；当前保留 A 候选，不自动重试`);
        graphicDecision = { ...graphicDecision, state: 'review', action: 'review', reason: `B 重绘未完成，当前显示 A 保真候选：${reason}` };
      }
    }
    if (facts.intent === 'preserve') decision = graphicDecision;
  }
  if (!artworkQualityPassed(graphicQuality)) reviewReasons.push(`主体清晰度 ${graphicQuality.score.toFixed(2)} / 80；目标放大 ${graphicQuality.requiredScale.toFixed(2)} 倍，未满足使用标准`);
  const executedMethod: ArtworkMethod = facts.intent === 'compose' ? 'compose' : graphicMethod;
  if (request.artworkMethod === 'redraw' && executedMethod !== 'redraw') {
    throw new Error(artworkQualityPassed(graphicQuality)
      ? '保真处理已达标，无需高清重绘。请选择原图保真；本次未执行重绘。'
      : `高清重绘未完成，未将其他处理结果当作重绘成品保存。${reviewReasons.join('；') || graphicDecision.reason}`);
  }
  const route: ArtworkRouteDecision = { route: executedMethod === 'generate' || executedMethod === 'redraw' ? 'model' : 'fidelity', label: `${{ preserve: 'A 原图保真', redraw: 'B 高清重绘', compose: 'C 图文组合', generate: 'D 整图生成' }[executedMethod]}`, reasons: [decision.reason, ...operations], userOverride: request.processingRoute !== 'auto' };
  const resolution = assessArtworkResolution({ subjectWidth: source.subjectWidth, subjectHeight: source.subjectHeight });
  if (executedMethod === 'compose' && (intent.hasStyleReference || intent.specialTypography) && request.exactText.trim()) route.route = 'hybrid';
  const componentPlan = buildArtworkComponentPlan({ request, resolution, route });
  const metadata = await sharp(graphic).metadata();
  let draft = executedMethod === 'generate' ? createLegacyArtworkDraft(dataUrl(graphic)) : artworkDraftFromPreparedGraphic({
    graphicDataUrl: dataUrl(graphic), recolorMaskUrl: await createArtworkRecolorMask(graphic, request.instruction).then(mask => mask ? dataUrl(mask) : null), graphicWidth: metadata.width!, graphicHeight: metadata.height!,
    request: executedMethod === 'preserve' || executedMethod === 'redraw' ? { ...request, instruction: '保留原图形、原文字和原颜色', exactText: '', layoutNote: '' } : request,
    quality: evaluation(source), enhancement, backgroundRemoval, sourceKind: sourceProfile.kind, resolution, route, componentPlan,
  });
  if (executedMethod === 'generate') {
    const scale = Math.min(760 / metadata.width!, 760 / metadata.height!);
    draft.graphic.width = Math.max(1, Math.round(metadata.width! * scale));
    draft.graphic.height = Math.max(1, Math.round(metadata.height! * scale));
  }
  if (executedMethod === 'compose') {
    const graphicEdit = request.instruction.split(/[，。；;\n]/u).filter(clause => !/(?:文字|字体|字色)/u.test(clause)).join('\n');
    const color = referenceColor?.hex ?? artworkEditColor(graphicEdit);
    if (referenceColor && !draft.graphic.recolorMaskUrl) throw new Error('已提取参考色，但主要图案的改色区域未能确定，请核对抠图结果');
    draft.graphic.recolor = color && draft.graphic.recolorMaskUrl ? { mode: 'solid', color } : { mode: 'original', color: null };
  }
  const primaryCutoutReceipt = cutoutReceipt;
  if (route.route === 'hybrid' && reviewReasons.length) {
    reviewReasons.push('主体尚未可用，特殊字形尚未生成；当前文字仅为排版占位，不能确认使用');
  } else if (route.route === 'hybrid') {
    const styledTexts = [];
    for (const [index, text] of prompts.styledTexts.entries()) {
      const generated = await services.generate(text.prompt, request.referenceImages.map(reference => reference.image.dataUrl));
      if (generated.generationNote) operations.push(generated.generationNote);
      await services.saveImage(runId, `styled-text-${index}`, generated.bytes);
      const bytes = await generatedCutout(generated.bytes, services);
      const measured = await services.measure(bytes);
      if (!artworkQualityPassed(measured)) reviewReasons.push(`文字“${text.text}”清晰度 ${measured.score.toFixed(2)}，尚未达标`);
      const size = await sharp(bytes).metadata();
      styledTexts.push({ id: componentPlan.texts[index].id, value: text.text, sourceUrl: dataUrl(bytes), recolorMaskUrl: dataUrl(bytes), width: size.width!, height: size.height! });
      model = generated.model;
      usedPrompt = [usedPrompt, text.prompt].filter(Boolean).join('\n\n');
    }
    const vertical = draft.layout.preset === 'vertical' || draft.layout.preset === 'verticalReverse';
    draft = createHybridArtworkDraft({ primaryGraphic: draft.graphic, styledTexts, sequence: componentPlan.sequence, preprocessing: draft.preprocessing });
    if (vertical) {
      const maximumHeight = 1024 / (componentPlan.sequence.length + 1) * .8;
      const position = (graphic: typeof draft.graphic) => {
        const scale = Math.min(1, maximumHeight / graphic.height);
        return { ...graphic, x: 512, y: graphic.x, width: graphic.width * scale, height: graphic.height * scale };
      };
      draft.graphic = position(draft.graphic);
      draft.extraGraphics = draft.extraGraphics?.map(position);
    }
    operations.push(`C 特殊字形生成 ${styledTexts.length} 个组件，程序合成`);
  } else if (executedMethod === 'compose') {
    if (componentPlan.texts.length > 1 && draft.text) {
      const vertical = draft.layout.preset === 'vertical' || draft.layout.preset === 'verticalReverse';
      const step = 1024 / (componentPlan.sequence.length + 1);
      const textLayers = componentPlan.texts.map(text => {
        const index = componentPlan.sequence.findIndex(item => item.kind === 'text' && item.id === text.id);
        return { ...draft.text!, id: text.id, value: text.value, x: vertical ? 512 : step * (index + 1), y: vertical ? step * (index + 1) : 512, boxWidth: vertical ? 760 : step * .85 };
      });
      const index = componentPlan.sequence.findIndex(item => item.kind === 'graphic');
      const scale = Math.min(1, (step * .85) / (vertical ? draft.graphic.height : draft.graphic.width));
      draft.graphic = { ...draft.graphic, x: vertical ? 512 : step * (index + 1), y: vertical ? step * (index + 1) : 512, width: draft.graphic.width * scale, height: draft.graphic.height * scale };
      draft.text = textLayers[0]; draft.extraTexts = textLayers.slice(1); draft.layout.preset = 'custom';
    }
    operations.push('C 程序生成准确文字与组合排版');
  }
  const actualPromptHash = usedPrompt ? artworkPromptHash(usedPrompt) : prompts.hash;
  const report: ArtworkRoutingReport = { version: ARTWORK_ROUTING_STANDARD.version, runId, requestHash: prompts.hash, sourceSha256: artworkSha256(sourceBytes), decision, graphicDecision, executedMethod, graphicMethod,
    facts, source, repair, graphic: graphicQuality, reviewReasons, operations, model, prompt: usedPrompt, promptHash: actualPromptHash, timings: [...timings], ...(redraw ? { redraw } : {}) };
  await services.saveImage(runId, 'prepared-graphic', graphic);
  await services.saveReport(report);
  progress('图案处理完成，正在保存文件…', true);
  draft.preprocessing = { ...draft.preprocessing, referenceColor, cutout: primaryCutoutReceipt, cutoutRuns, backgroundRemoval, edgeRefinement, routingReport: report, processingRoute: route.route, routeReasons: route.reasons, generationModel: model, resolvedPrompt: usedPrompt, promptVersion: prompts.version, promptHash: actualPromptHash, imageMapping: prompts.imageMapping };
  return { status: 'prepared', draft, preprocessing: { timings: [...timings], cutout: primaryCutoutReceipt, cutoutRuns, nativeOutput: executedMethod === 'generate' && backgroundRemoval === 'none', modelLayoutPreserved: executedMethod === 'generate', edgeRefinement, evaluation: evaluation(source), enhancement, backgroundRemoval, sourceKind: sourceProfile.kind, resolution,
    maskQuality: await alphaMaskReport(graphic), decisionRule: [...operations, ...reviewReasons].join('；'), route, generationModel: model, componentPlan, resolvedPrompt: usedPrompt, promptVersion: prompts.version, promptHash: actualPromptHash, imageMapping: prompts.imageMapping } };
}
