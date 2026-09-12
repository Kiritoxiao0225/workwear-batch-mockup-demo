import { artworkJobStep, assertArtworkComponentSubmissionSafe } from './artwork-job-runtime';
import { locateArtworkEdit } from './artwork-edit-localization';
import { compositeArtworkLocalEdit, eraseDetachedArtwork, validateLocalEditPlan, type ArtworkLocalEditPlan } from './artwork-local-edit';
import { recolorArtworkPixels } from './artwork-pixel-recolor';
import { assertArtworkMask } from './artwork-panel-mask';
import { artworkBackgroundContract, artworkBackgroundRequirement } from '@/lib/artwork-background-contract';
import type { ArtworkProtectionPolicy } from '@/lib/artwork-protection';
import { withSourceRequirements, compileArtworkRequirements, contentImageLabels } from '@/lib/artwork-reliability';
import { artworkProtectionPolicy } from '@/lib/artwork-protection';
import { fontReferenceRequirement } from '@/lib/artwork-font-reference';
import { cropArtworkFontInput } from './artwork-font-reference';
import { artworkCorrectionPrompt } from '@/lib/artwork-correction';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createHybridArtworkDraft, createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { ARTWORK_ROUTING_STANDARD, decideArtworkMethod, type ArtworkMethod, type ArtworkQualityMeasurement, type ArtworkRoutingReport } from '@/lib/artwork-routing-standard';
import { artworkEditColor, artworkRequirementFacts, standardArtworkPrompts, artworkPromptHash } from '@/lib/artwork-routing-request';
import { assessArtworkResolution, artworkDraftFromPreparedGraphic, artworkIntent, buildArtworkComponentPlan, type ArtworkPreparationRequest, type ArtworkPreparationResponse, type ArtworkQualityEvaluation, type ArtworkRouteDecision } from '@/lib/task-review-artwork';
import { inspectArtworkSource, alphaMaskReport, createArtworkRecolorMask } from '@/lib/server/artwork-image-processing';
import { artworkSha256, measureArtworkPixels, artworkPixelTarget } from '@/lib/server/artwork-quality';
import { prepareTaskArtwork } from '@/lib/server/media-kit-artwork';
import { generateStandardArtwork, inspectRedrawSource } from '@/lib/server/ark-artwork-processing';
import { saveArtworkRoutingReport, saveArtworkRunImage, saveArtworkGenerationReceipt } from '@/lib/server/artwork-routing-records';
import type { NativeArtworkCandidate } from '@/lib/task-review-artwork';
import type { ArtworkCutoutMode, ArtworkCutoutReceipt, ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { cutoutArtworkForPipeline, ArtworkCutoutPendingError } from './artwork-cutout';
import type { ArtworkProgressEvent, ArtworkTiming } from '@/lib/artwork-progress';
import { artworkReferenceColors, type ArtworkReferenceColorReceipt } from '@/lib/artwork-reference-color';
import { resolveArtworkReferenceColor } from './artwork-reference-color';
import { artworkModelEdits, artworkGraphicRemovals, artworkGraphicRemovalPrompt, artworkGraphicRemovalChecks, type ArtworkEditVerification } from '@/lib/artwork-model-edits';
import { verifyArtworkModelEdits, verifyArtworkTextComponent } from './artwork-content-inspection';
import { artworkTextRemovalChecks } from '@/lib/artwork-text-contract';
import { inspectArtworkSourceAssessment } from './artwork-source-assessment';
import { artworkReconstructionRequirements } from '@/lib/artwork-source-assessment';
import { artworkSolidColor } from '@/lib/artwork-solid-color';
import { flattenArtworkSolidColor } from './artwork-solid-color';
import { selectArtworkSource } from './artwork-source-selection';
import { artworkSeparationPrompt } from '@/lib/artwork-generation-background';
import { artworkReviewDecision, reconstructionReviewRequirements, ARTWORK_UNCERTAIN_WARNING, ARTWORK_INSPECTION_UNAVAILABLE_WARNING } from '@/lib/artwork-review-policy';

async function routedCutout(bytes: Buffer, options: { scene?: 'product' | 'general'; crop?: boolean; mode?: ArtworkCutoutMode; protection?: ArtworkProtectionPolicy | null } = {}) {
  return (await cutoutArtworkForPipeline(bytes, options.mode, options.protection ?? undefined)).bytes;
}

export class NativeArtworkCandidateError extends Error {
  constructor(public candidate: NativeArtworkCandidate) { super(candidate.reason); }
}

export const standardArtworkServices = {
  measure: measureArtworkPixels,
  fidelity: prepareTaskArtwork,
  generate: generateStandardArtwork,
  inspect: inspectRedrawSource,
  inspectSource: inspectArtworkSourceAssessment,
  cutout: routedCutout,
  saveReport: saveArtworkRoutingReport,
  saveImage: saveArtworkRunImage,
  saveGeneration: saveArtworkGenerationReceipt,
  resolveReferenceColor: resolveArtworkReferenceColor,
  verifyEdits: verifyArtworkModelEdits,
  verifyText: verifyArtworkTextComponent,
};
export type StandardArtworkServices = typeof standardArtworkServices & {
  locateEdit?: typeof locateArtworkEdit;
  resumeGenerationInput?: typeof import('./artwork-job-runtime').resumeArtworkGenerationInput;
  resumeGenerationPrompt?: (prompt: string, images: string[], settings: { background?: 'auto' | 'transparent' }) => Promise<string>;
};
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const bytesFromDataUrl = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const evaluation = (quality: ArtworkQualityMeasurement): ArtworkQualityEvaluation | null => quality.score === null || quality.vqscore === null ? null : ({ blur: quality.rawBlur ?? 100 - quality.score, vqscore: quality.vqscore, noise: quality.noise, compressionArtifacts: quality.compressionArtifacts });

async function generatedCutout(bytes: Buffer, services: StandardArtworkServices, protection?: ArtworkProtectionPolicy) {
  const cutout = await services.cutout(bytes, { protection: protection ?? null });
  await assertArtworkMask(cutout, protection);
  return cutout;
}

/** One fidelity enhancement when needed. Content inspection is advisory at every stage. */
export async function prepareStandardArtwork(request: ArtworkPreparationRequest, services: StandardArtworkServices = standardArtworkServices, onProgress?: (event: ArtworkProgressEvent) => void): Promise<ArtworkPreparationResponse> {
  request = withSourceRequirements(request);
  const background = artworkBackgroundContract(request);
  const protection = artworkProtectionPolicy(request.instruction, request.layoutNote, request);
  const contractIssues = compileArtworkRequirements(request).issues;
  if (contractIssues.length) throw new Error(contractIssues.map(issue => issue.message).join('；'));
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
  const cutoutWarnings: string[] = [];
  const originalCutout = services.cutout;
  services = { ...services, cutout: async (bytes, options) => {
    if (originalCutout !== routedCutout) return originalCutout(bytes, options);
    const result = await cutoutArtworkForPipeline(bytes, request.cutoutMode, options?.protection === null ? undefined : options?.protection ?? protection);
    if (result.receipt.integrityCheck?.warning) cutoutWarnings.push(result.receipt.integrityCheck.warning);
    cutoutReceipt = result.receipt;
    cutoutRuns.push(result.receipt);
    return result.bytes;
  } };
  const underlying = services;
  let measurements = 0;
  services = { ...underlying,
    measure: bytes => timed(measurements++ === 0 ? 'sourcePixels' : 'resultPixels', async () => artworkPixelTarget(await underlying.measure(bytes), request.printPlacement)),
    generate: (...args) => timed('generation', () => underlying.generate(...args)),
    cutout: (...args) => timed('cutout', () => underlying.cutout(...args)),
    fidelity: (...args) => timed('fidelity', () => underlying.fidelity(...args)),
    inspect: (...args) => timed('inspection', () => underlying.inspect(...args)),
  };
  let prompts = standardArtworkPrompts(request);
  if (request.expectedPromptVersion && request.expectedPromptVersion !== prompts.version) throw new Error('页面制作要求版本已过期，请刷新后重试');
  if (request.expectedPromptHash && request.expectedPromptHash !== prompts.hash) throw new Error('页面显示的制作要求与服务端不一致，已停止处理');
  request = await cropArtworkFontInput(request);
  const initialFacts = artworkRequirementFacts(request);
  const initialDecision = decideArtworkMethod(initialFacts);
  const inspectSelectionFirst = initialFacts.sourceAssessmentRequired && initialFacts.intent === 'compose'
    && initialFacts.editSpecification === 'incomplete' && !initialFacts.blockers.length && artworkIntent(request).selectiveComposition;
  if (initialDecision.state === 'review' && !inspectSelectionFirst) throw new Error(`${initialDecision.reason} ${initialFacts.blockers.join('；')}`);
  if (request.sourceScope !== 'wholeImage' && request.primaryImageRole !== 'reference' && (!request.sourceAssessment || request.sourceAssessment.kind === 'unknown'
    || !request.sourceAssessment.recognizedContent
    || request.sourceAssessment.needsReconstruction === null
    || (request.sourceAssessment.kind === 'flat-artwork' && !request.sourceAssessment.needsReconstruction && !request.sourceAssessment.selection)
    || inspectSelectionFirst)) {
    progress('正在识别本次要用的图案及其范围，选择制作方式…');
    const sourceAssessment = await timed('inspection', () => services.inspectSource(request.image.dataUrl,
      `${request.instruction}\n${request.layoutNote}`)).catch(error => {
        if (!request.sourceAssessment || request.sourceAssessment.kind === 'unknown') throw error;
        return { ...request.sourceAssessment, uncertainDetails: [...request.sourceAssessment.uncertainDetails, ARTWORK_INSPECTION_UNAVAILABLE_WARNING].slice(0, 12) };
      });
    request = { ...request, sourceAssessment };
    // A pending recommendation is resolved before any image generation/cutout.
    // Record the actual resolved prompt/hash, while checking the submitted hash above.
    prompts = standardArtworkPrompts(request);
  }
  const facts = artworkRequirementFacts(request);
  if (request.artworkMethod === 'redraw') facts.reconstructSource = true;
  if (request.correction) { facts.intent = 'generate'; facts.intentReason = '按已选问题修正当前图案'; facts.reconstructSource = false; facts.editSpecification = 'complete'; }
  if (facts.sourceAssessmentRequired && (!facts.sourceAssessment || facts.sourceAssessment.kind === 'unknown'
    || facts.sourceAssessment.needsReconstruction === null)) throw new Error('尚不能确定要提取的图案与实物载体，请在制作要求中明确目标区域。');
  const modelEdits = request.primaryImageRole === 'reference' ? [] : artworkModelEdits(request);
  let decision = decideArtworkMethod(facts);
  if (decision.state === 'review') throw new Error(`${decision.reason} ${facts.blockers.join('；')}`);
  if (decision.method === 'generate' && !request.generationPrompt?.trim() && !request.fontReference && !request.correction && contentImageLabels(request).length < 2) throw new Error('请先整理生图提示词，再制作图案');
  const reconstructSource = Boolean(facts.reconstructSource);
  let modelPreparation = decision.method === 'generate' || reconstructSource;
  let modelPrompt = artworkSeparationPrompt(request.correction ? artworkCorrectionPrompt(request.correction.issues, `${request.instruction}\n${request.layoutNote}\n准确文字：${request.exactText}\n${fontReferenceRequirement(request.fontReference, request.exactText)}`, request.primaryImageRole) : (decision.method === 'generate' ? prompts.generate : prompts.reconstruct) ?? '', request.sourceScope === 'wholeImage');
  if (request.correction) prompts = { ...prompts, imageMapping: [
    { sourceLabel: request.primaryImageLabel, modelInputLabel: '图1', role: request.primaryImageRole ?? 'content', requirement: '客户原素材，依指定角色使用' },
    { sourceLabel: '当前已保存图案', modelInputLabel: '图2', role: 'content', requirement: '保留正确部分，只修正已选问题' },
    ...request.referenceImages.map((image, index) => ({ sourceLabel: image.label, modelInputLabel: `图${index + 3}`, role: 'reference' as const, requirement: image.label === request.fontReference?.label ? '字体参考裁片' : '按制作要求参考' })),
  ] };
  if (request.correction && request.fontReference) modelPrompt += `\n图片对应：${prompts.imageMapping.map(image => `输入${image.modelInputLabel} = WPS ${image.sourceLabel}（${image.requirement}）`).join('；')}`;
  if (reconstructSource && decision.method !== 'generate') prompts = { ...prompts,
    imageMapping: prompts.imageMapping.filter(mapping => mapping.sourceLabel === request.primaryImageLabel)
      .map(mapping => ({ ...mapping, modelInputLabel: '图1' })) };
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
  const originalSourceDataUrl = request.image.dataUrl;
  const originalSourceBytes = bytesFromDataUrl(originalSourceDataUrl);
  const selectedSource = request.sourceScope !== 'wholeImage' && request.primaryImageRole !== 'reference'
    && (request.sourceAssessment?.selection?.scope === 'region' || facts.sourceAssessmentRequired && request.sourceAssessment?.kind === 'flat-artwork' && !modelPreparation)
    ? await selectArtworkSource(originalSourceBytes, request.sourceAssessment!.selection)
    : { bytes: originalSourceBytes };
  const sourceBytes = selectedSource.bytes;
  const pixelRecolor = await recolorArtworkPixels(sourceBytes, request);
  if (pixelRecolor) {
    // Resolve from actual current pixels, not a UI route label. Pure colour edits
    // need neither image generation nor resolution-driven geometric alteration.
    facts.intent = 'compose'; facts.reconstructSource = false; facts.editSpecification = 'complete';
    decision = decideArtworkMethod(facts); modelPreparation = false;
  }
  if (selectedSource.receipt) request = { ...request, image: { ...request.image, dataUrl: dataUrl(sourceBytes), mimeType: 'image/png' } };
  const sourceProfile = await inspectArtworkSource(sourceBytes);
  const runId = randomUUID();
  let availableCandidate: NativeArtworkCandidate | undefined;
  try {
  const operations: string[] = [];
  if (selectedSource.receipt) {
    const { bounds } = selectedSource.receipt;
    operations.push(`先从原素材定位并裁出本次图案 ${bounds.width}×${bounds.height}px，再按实际像素增强与抠图`);
    await services.saveImage(runId, 'selected-source', sourceBytes);
    await preview(sourceBytes, '已取出本次图案，正在处理');
  }
  const reviewWarnings: string[] = request.sourceAssessment?.uncertainDetails.length || request.sourceAssessment?.recognizedContent?.text.some(text => !text.certain) ? [ARTWORK_UNCERTAIN_WARNING] : [];
  if (background.scope === 'ambiguous') reviewWarnings.push(artworkBackgroundRequirement(background));
  const textComposition: NonNullable<ArtworkRoutingReport['textComposition']> = { operation: prompts.textOperation, components: [] };
  async function enhanceGenerated(bytes: Buffer) {
    const measured = await services.measure(bytes);
    if (measured.requiredScale <= 1) return bytes;
    progress('生成图主体像素不足，正在做一次保真增强…');
    const prepared = await services.fidelity({ ...request, image: { ...request.image, dataUrl: dataUrl(bytes), mimeType: 'image/png' },
      artworkMethod: undefined, instruction: '保留完整图案的文字、结构、颜色与长宽比', exactText: '', layoutNote: '', referenceImages: [],
      processingRoute: 'fidelity', enhancementMode: 'professional', sourceScope: 'subject' }, { measuredQuality: null, cutout: async value => value });
    const enhanced = bytesFromDataUrl(prepared.draft.graphic.sourceUrl);
    await assertArtworkMask(enhanced, protection);
    operations.push('生成图主体像素不足，完成一次保真增强；不重复增强或自动重绘');
    return enhanced;
  }
  // Generated components are never standalone finished artwork. Preserve a paid
  // result on any failure, but do not permit a cutout retry to bypass its checks.
  async function prepareComponent(prompt: string, images: string[], label: string, verify: (bytes: Buffer) => Promise<void>, preserveBackground = false, localEdit?: { source: Buffer; plan: ArtworkLocalEditPlan }) {
    await assertArtworkComponentSubmissionSafe(prompt, images, { background: 'auto' });
    const generated = await services.generate(prompt, images, { background: 'auto' });
    let bytes = generated.bytes;
    let stage = '保存组件原图';
    try {
      await services.saveImage(runId, `${label}-original`, bytes);
      stage = '处理组件背景';
      bytes = preserveBackground ? await sharp(bytes).png().toBuffer() : await generatedCutout(bytes, services, label.startsWith('styled-text-') ? undefined : protection);
      if (localEdit) {
        stage = '恢复未编辑区域原始像素';
        bytes = await compositeArtworkLocalEdit(localEdit.source, bytes, localEdit.plan);
        if (!preserveBackground) await assertArtworkMask(bytes, protection);
      } else if (!preserveBackground) bytes = await enhanceGenerated(bytes);
      stage = '核对组件内容';
      try { await verify(bytes); } catch { reviewWarnings.push(ARTWORK_INSPECTION_UNAVAILABLE_WARNING); }
      stage = '读取组件实际尺寸';
      const quality = await services.measure(bytes);
      stage = '保存核对后的组件';
      await services.saveImage(runId, `${label}-checked`, bytes);
      return { ...generated, bytes, quality };
    } catch (error) {
      const reason = `${stage}未通过：${error instanceof Error ? error.message : String(error)}`;
      // Receipt storage failure must not hide the already generated image.
      try { await services.saveGeneration(runId, { runId, model: generated.model, prompt, promptHash: artworkPromptHash(prompt),
        status: 'needs-review', component: label, reason, textComposition, timings: [...timings],
        originalSha256: artworkSha256(generated.bytes), outputSha256: artworkSha256(bytes) }); }
      catch { /* The response still carries the actual image for recovery. */ }
      throw new NativeArtworkCandidateError({ runId, url: dataUrl(bytes), model: generated.model, promptHash: artworkPromptHash(prompt),
        stage: 'edit-review', requiresEditVerification: true,
        cutout: error instanceof ArtworkCutoutPendingError ? error.result : undefined,
        reason: `${reason}。已保留本次图片，尚未合成或保存成品，请先核对；不会自动再次生图。` });
    }
  }
  if (referenceColor) operations.push(`参考${referenceColor.label}取色 ${referenceColor.hex}：${referenceColor.description}`);
  const preserveWholeImage = request.sourceScope === 'wholeImage';
  const needsSubjectCutout = !modelPreparation && !preserveWholeImage;
  let earlyGenerated: Awaited<ReturnType<StandardArtworkServices['generate']>> | undefined;
  let earlyCutout: PromiseSettledResult<Buffer> | undefined;
  let source: ArtworkQualityMeasurement;
  if (modelPreparation) {
    // Pixel measurement runs locally, independently of the paid generation.
    progress(reconstructSource ? '正在按原设计重建独立图案…' : '正在生成完整图案…');
    const results = await Promise.allSettled([
      services.measure(sourceBytes),
      (async () => {
        let images = request.correction ? [request.image.dataUrl, request.correction.image.dataUrl, ...request.referenceImages.map(image => image.image.dataUrl)] : reconstructSource && decision.method !== 'generate' ? [request.image.dataUrl] : prompts.imageMapping.map(mapping => mapping.sourceLabel === request.primaryImageLabel ? request.image.dataUrl : request.referenceImages.find(reference => reference.label === mapping.sourceLabel)!.image.dataUrl);
        if (services.resumeGenerationInput) {
          const originalImages = images.map(image => image === request.image.dataUrl ? originalSourceDataUrl : image);
          const resumed = await services.resumeGenerationInput(modelPrompt!, images, { background: 'auto' }, originalImages);
          modelPrompt = resumed.prompt; images = resumed.images;
          if (resumed.reusedOriginalInput) operations.push('复用此前按原素材已生成的模型图；本轮不按新选区重复生图，仅按新规则核对');
        } else if (services.resumeGenerationPrompt) modelPrompt = await services.resumeGenerationPrompt(modelPrompt!, images, { background: 'auto' });
        const generated = await services.generate(modelPrompt!, images, { background: 'auto' });
        availableCandidate = { runId, url: dataUrl(generated.bytes), model: generated.model,
          stage: 'processing', promptHash: artworkPromptHash(modelPrompt!), reason: '', requiresEditVerification: true, retryable: true };
        progress('图案已生成，正在保存原图…', true);
        await preview(generated.bytes, '刚生成的图 · 还要去背景和检查，尚未保存成品');
        try { await services.saveImage(runId, 'generated-original', generated.bytes); }
        catch (error) {
          console.error('[artwork] generated original persistence failed', { runId,
            name: error instanceof Error ? error.name : 'UnknownError',
            code: error && typeof error === 'object' && 'code' in error ? error.code : undefined });
          throw new NativeArtworkCandidateError({ runId, url: dataUrl(generated.bytes), model: generated.model,
            stage: 'original-save', promptHash: artworkPromptHash(modelPrompt!),
            requiresEditVerification: reconstructSource || modelEdits.length > 0 || prompts.textOperation === 'replace',
            reason: '图案已生成，但保存原图失败，还没有开始抠图或保存成品。请先下载这张原图，避免重复生图。' });
        }
        progress(preserveWholeImage ? '图案原图已保存，按整图范围保留背景…' : '图案原图已保存，正在处理透明背景…');
        // Pixel measurement is independent: do not leave a cutout worker idle while it runs.
        if (!preserveWholeImage) [earlyCutout] = await Promise.allSettled([services.cutout(generated.bytes, { scene: 'product', crop: false })]);
        return generated;
      })(),
    ]);
    if (results[1].status === 'rejected') throw results[1].reason;
    earlyGenerated = results[1].value;
    if (results[0].status === 'rejected') {
      const reason = `图案已生成，但原图尺寸读取未完成：${String(results[0].reason)}。已保留模型原图，尚未保存成品。`;
      await services.saveGeneration(runId, { runId, model: earlyGenerated.model, status: 'needs-review', reason, timings, metadata: earlyGenerated.generationMetadata });
      throw new NativeArtworkCandidateError({ runId, url: dataUrl(earlyGenerated.bytes), model: earlyGenerated.model, reason, promptHash: artworkPromptHash(modelPrompt!) });
    }
    source = results[0].value;
  } else {
    progress('正在检查原图并处理图案…');
    source = await services.measure(sourceBytes);
  }
  facts.sourceClarity = source;
  facts.requiredScale = source.requiredScale;
  decision = decideArtworkMethod(facts);
  operations.push('读取主体实际像素，未调用数字评分');
  const reviewReasons: string[] = [];
  let editVerification: ArtworkEditVerification | undefined;
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

  if (modelPreparation) {
    usedPrompt = modelPrompt!;
    const generated = earlyGenerated!;
    if (generated.generationNote) operations.push(generated.generationNote);
    const metadata = await sharp(generated.bytes).metadata();
    const originalMask = await alphaMaskReport(generated.bytes);
    let mask = originalMask;
    graphic = generated.bytes;
    let cutoutFailure = '';
    let solidColor: Awaited<ReturnType<typeof flattenArtworkSolidColor>>['receipt'] | undefined;
    let pendingCutout: ArtworkCutoutResult | undefined;
    try {
      // Keep the full model layout, including detached lettering, on its original canvas.
      if (earlyCutout?.status === 'rejected') throw earlyCutout.reason;
      graphic = preserveWholeImage ? await sharp(generated.bytes).png().toBuffer() : earlyCutout?.status === 'fulfilled' ? earlyCutout.value : await services.cutout(generated.bytes, { scene: 'product', crop: false });
      const preparedMetadata = await sharp(graphic).metadata();
      if (preparedMetadata.format !== 'png' || !preserveWholeImage && !preparedMetadata.hasAlpha) throw new Error('抠图结果不是带透明通道的 PNG');
      mask = await alphaMaskReport(graphic);
      if (!preserveWholeImage) await assertArtworkMask(graphic, protection);
      const solidContract = preserveWholeImage ? null : artworkSolidColor(request);
      if (solidContract) {
        const flattened = await flattenArtworkSolidColor(graphic, solidContract);
        graphic = flattened.bytes;
        solidColor = flattened.receipt;
        operations.push(`整组图案统一填色 ${solidColor.color}，保持原透明度、轮廓与镂空`);
      }
      backgroundRemoval = preserveWholeImage ? 'none' : 'product';
      if (availableCandidate) availableCandidate = { ...availableCandidate, url: dataUrl(graphic) };
      progress(preserveWholeImage ? '已保留整图背景，正在核对图案内容…' : '透明背景已处理，正在核对图案内容…');
      await preview(graphic, '去背景后的图 · 还在检查，尚未保存成品');
      operations.push(preserveWholeImage ? '按明确整图范围保留背景，不抠图或统一填色' : '整图生成后按抠图方式分流；保留模型字体、颜色与排版，不重新排字');
    } catch (error) {
      if (error instanceof ArtworkCutoutPendingError) pendingCutout = error.result;
      cutoutFailure = `图案已生成，但抠图未完成：${error instanceof Error ? error.message : String(error)}。已保留模型原图供下载，未作为成品上衣。`;
    }
    if (!cutoutFailure && !preserveWholeImage) {
      graphic = await enhanceGenerated(graphic);
      // Enhancement may introduce colour variation; enforce an explicit uniform ink again.
      const solidContract = artworkSolidColor(request);
      if (solidContract) graphic = (await flattenArtworkSolidColor(graphic, solidContract)).bytes;
      mask = await alphaMaskReport(graphic);
      if (availableCandidate) availableCandidate = { ...availableCandidate, url: dataUrl(graphic) };
    }
    const verificationRequirements = request.correction ? request.correction.issues.map(issue => `${issue.location}：${issue.action}；${issue.preserve}`) : reconstructSource
      ? reconstructionReviewRequirements(request.sourceAssessment!.targetDescription,
        artworkReconstructionRequirements(request.sourceAssessment!, request).join('\n'))
      : modelEdits.length ? [...modelEdits, '未点名修改的原有文字、字形、数字、装饰、配色及相对排版保持原样；无关来源水印与外围背景除外'] : [];
    if (decision.method === 'generate' && prompts.textOperation === 'replace') verificationRequirements.push(
      `指定旧字已按要求替换为 ${JSON.stringify(request.exactText)}，新字只出现要求的次数，旧字不再残留：${request.instruction}`,
      '未指定替换的原文字与原 Logo 图形数量、结构仍保留，没有把原图和改字后的完整图重复拼接。');
    if (solidColor) verificationRequirements.push(`按要求整组统一颜色：${solidColor.requirement}。检查图案实际色相符合要求，笔画内部均匀，未改变轮廓与镂空。`);
    if (!cutoutFailure && verificationRequirements.length) {
      progress(reconstructSource ? '正在核对原文字、标志与载体残留…' : '正在检查颜色是否改对、其他地方有没有被误改…');
      try {
        editVerification = await timed('editVerification', () => services.verifyEdits(sourceBytes, graphic,
          verificationRequirements));
        if (editVerification.sourceSha256 !== artworkSha256(sourceBytes) || editVerification.outputSha256 !== artworkSha256(graphic)) {
          throw new Error('核对记录与当前图片不一致，本次核对结论不可使用');
        }
        const review = artworkReviewDecision(editVerification);
        reviewWarnings.push(...review.warningMessages);
      } catch {
        editVerification = undefined;
        reviewWarnings.push(ARTWORK_INSPECTION_UNAVAILABLE_WARNING);
      }
    }
    await services.saveGeneration(runId, { runId, model: generated.model, prompt: usedPrompt, promptHash: artworkPromptHash(usedPrompt), imageMapping: prompts.imageMapping,
      sourceSha256: artworkSha256(sourceBytes), originalSha256: artworkSha256(generated.bytes), metadata: generated.generationMetadata,
      width: metadata.width, height: metadata.height, originalHasAlpha: metadata.hasAlpha, originalMask, mask, backgroundRemoval,
      sourceAssessment: request.sourceAssessment, editVerification, reviewWarnings, solidColor,
      status: cutoutFailure ? 'needs-review' : reviewWarnings.length ? 'prepared-with-warnings' : 'cutout-accepted', reason: cutoutFailure, timings: [...timings] });
    if (cutoutFailure) throw new NativeArtworkCandidateError({ runId, url: dataUrl(generated.bytes), model: generated.model, reason: cutoutFailure,
      promptHash: artworkPromptHash(usedPrompt), cutout: pendingCutout, requiresEditVerification: verificationRequirements.length > 0 });
    if (editVerification) operations.push(reviewWarnings.length ? '自动核对有提醒，图案可继续保存和查看' : reconstructSource ? '已核对目标文字、标志、排版与载体残留' : '已逐项核对指定改色及其余图案保留要求');
    model = generated.model;
    graphicMethod = reconstructSource && decision.method !== 'generate' ? 'redraw' : 'generate';
    graphicQuality = await services.measure(graphic);
    operations.push(graphicMethod === 'redraw' ? `B 原设计重建 1 次；先还原目标图案，再去底；${solidColor ? '按明确要求统一单色' : '保留原设计配色'}` : 'D 白底整图生成 1 次', preserveWholeImage ? '整图范围未执行透明度门禁，不宣称通过去底检查' : '抠图后真实 Alpha 检查通过', '记录处理后主体实际像素');
    if (graphicMethod === 'redraw') redraw = { status: 'completed', stage: 'measurement', model,
      inputSha256: artworkSha256(sourceBytes), promptHash: artworkPromptHash(usedPrompt) };
    else graphicDecision = decision;
  } else if (pixelRecolor) {
    graphic = pixelRecolor.bytes;
    graphicQuality = await services.measure(graphic);
    operations.push(`像素级单前景改色：保留原画布及全部 Alpha；${JSON.stringify(pixelRecolor.receipt)}`);
    await services.saveImage(runId, 'pixel-recolor-source', sourceBytes);
  } else {
    const runFidelity = async (mode: 'none' | 'professional') => {
      progress(mode === 'professional' ? '正在做保真高清，完成后处理透明背景…' : '原图无需高清增强，正在处理透明背景…');
      const prepared = await services.fidelity({ ...request,
        artworkMethod: undefined, exactText: '', layoutNote: '', referenceImages: [], processingRoute: 'fidelity', enhancementMode: mode }, {
        measuredQuality: null,
        ...(needsSubjectCutout ? { cutout: async (bytes: Buffer) => {
          progress('正在抠图并检查图案完整性…');
          return services.cutout(bytes);
        } } : {}),
      });
      const bytes = bytesFromDataUrl(prepared.draft.graphic.sourceUrl);
      backgroundRemoval = prepared.preprocessing.backgroundRemoval;
      edgeRefinement = prepared.preprocessing.edgeRefinement;
      return { bytes, measured: await services.measure(bytes), enhancement: prepared.preprocessing.enhancement };
    };
    const prepared = await runFidelity(graphicDecision.action === 'repair-once' ? 'professional' : 'none');
    enhancement = prepared.enhancement;
    // Keep the existing one-repair fallback, starting again from the original;
    // the repair must finish before its cutout, never enhance a damaged mask.
    enhancement = prepared.enhancement;
    graphic = prepared.bytes;
    graphicQuality = prepared.measured;
    operations.push(enhancement === 'none' ? 'A 原图去底' : 'A 保真修复 1 次', '记录处理后主体实际像素');
    if (needsSubjectCutout) operations.push('先按原图判断并完成所需高清增强，再按抠图方式去底与检查完整性');
    if (edgeRefinement) operations.push(edgeRefinement);
    if (enhancement !== 'none') {
      repair = graphicQuality;
      graphicFacts.repair = { attempts: 1, clarity: repair, requiredScale: repair.requiredScale };
      facts.repair = graphicFacts.repair;
    }
    graphicDecision = decideArtworkMethod(graphicFacts);
    if (facts.intent === 'preserve') decision = graphicDecision;
  }
  const executedMethod: ArtworkMethod = facts.intent === 'compose' ? 'compose' : graphicMethod;
  async function localEditPlan(source: Buffer, instruction: string) {
    availableCandidate = { runId, url: dataUrl(source), model: model ?? 'original-pixels', stage: 'edit-review',
      promptHash: prompts.hash, reason: '当前原图已保留，待安全定位局部修改', requiresEditVerification: true };
    const plan = await artworkJobStep('locate-edit-v1', 'inspection', [source, instruction], () => (services.locateEdit ?? locateArtworkEdit)(source, instruction));
    const meta = await sharp(source).metadata();
    validateLocalEditPlan(plan, meta.width!, meta.height!);
    operations.push(`局部修改定位：${JSON.stringify({ ...plan, sourceSha256: artworkSha256(source) })}`);
    if (plan.status === 'uncertain') throw new NativeArtworkCandidateError({ ...availableCandidate,
      reason: '未能安全定位待删除内容，未重绘原图；已保留当前候选，请明确选区或核对原图。' });
    return plan;
  }

  const graphicRemovals = artworkGraphicRemovals(request);
  if (executedMethod === 'compose' && graphicRemovals.length) {
    progress('正在删除指定内部元素，核对后继续排版…');
    const componentSource = graphic;
    const plan = await localEditPlan(componentSource, graphicRemovals.join('；'));
    if (plan.status === 'absent') reviewWarnings.push('当前图未定位到指定内部元素，保留原图，需人工核对删除要求');
    const checks = artworkGraphicRemovalChecks(graphicRemovals, request.exactText, request.sourceScope === 'wholeImage');
    const removalPrompt = artworkGraphicRemovalPrompt(graphicRemovals, request.exactText, request.sourceScope === 'wholeImage');
    const removed = plan.status === 'absent' ? { bytes: graphic, quality: graphicQuality, model } : await prepareComponent(removalPrompt, [dataUrl(componentSource)], 'graphic-removal', async bytes => {
      const verification = await timed('graphicRemovalVerification', () => services.verifyEdits(componentSource, bytes, checks));
      if (verification.sourceSha256 !== artworkSha256(componentSource) || verification.outputSha256 !== artworkSha256(bytes)
        || verification.checks.length !== checks.length || checks.some((requirement, index) => verification.checks[index]?.requirement !== requirement)) {
        throw new Error('局部删除核对没有对应当前图片或全部修改要求');
      }
      textComposition.graphicRemoval = verification;
      reviewWarnings.push(...artworkReviewDecision(verification).warningMessages);
    }, request.sourceScope === 'wholeImage', { source: componentSource, plan });
    graphic = removed.bytes;
    graphicQuality = removed.quality;
    model = removed.model;
    if (plan.status === 'located') {
      usedPrompt = [usedPrompt, removalPrompt].filter(Boolean).join('\n\n');
      operations.push('按明确选区执行内部元素删除并核对，区外像素原样保留；疑点保留提醒，继续图文组合');
    } else operations.push('当前素材未定位到指定内部元素，未执行删除或生图，保留候选与疑点');
  }
  if (executedMethod === 'compose' && prompts.textOperation === 'replace') {
    progress('正在检查当前素材是否还有指定旧字…');
    const componentSource = graphic;
    const plan = await localEditPlan(componentSource, `只处理指定旧字，不改主图形：${request.instruction}\n${request.layoutNote}\n新增文字 ${JSON.stringify(request.exactText)} 由程序另行排版，不是本次待删内容`);
    if (plan.status === 'absent') {
      operations.push('当前实际素材未发现指定旧字：跳过去字生成，主图形原像素直接复用');
      reviewWarnings.push('当前素材核查未见指定旧字，未重绘原图；请核对旧字是否已由裁选去除。');
    } else {
      const checks = artworkTextRemovalChecks(request);
      const verify = async (bytes: Buffer) => {
        const verification = await timed('textRemovalVerification', () => services.verifyEdits(componentSource, bytes, checks));
        if (verification.sourceSha256 !== artworkSha256(componentSource) || verification.outputSha256 !== artworkSha256(bytes)
          || verification.checks.length !== checks.length || checks.some((requirement, index) => verification.checks[index]?.requirement !== requirement)) throw new Error('去旧字核对没有对应当前图片或全部修改要求');
        textComposition.removal = verification;
        reviewWarnings.push(...artworkReviewDecision(verification).warningMessages);
      };
      const erased = request.sourceScope === 'wholeImage' ? null : await eraseDetachedArtwork(componentSource, plan);
      if (erased) {
        await assertArtworkMask(erased, protection);
        graphic = erased; graphicQuality = await services.measure(graphic);
        try { await verify(graphic); } catch { reviewWarnings.push(ARTWORK_INSPECTION_UNAVAILABLE_WARNING); }
        await services.saveImage(runId, 'text-base-checked', graphic);
        operations.push('按已定位选区删除独立旧字的 Alpha；主图形、负形、细标记与未编辑像素保持不变，无去字生图');
      } else {
        const removed = await prepareComponent(prompts.removeText!, [dataUrl(componentSource)], 'text-base', verify,
          request.sourceScope === 'wholeImage', { source: componentSource, plan });
        graphic = removed.bytes; graphicQuality = removed.quality; model = removed.model;
        usedPrompt = [usedPrompt, prompts.removeText].filter(Boolean).join('\n\n');
        operations.push('局部去字后恢复全部选区外原始 RGBA，再独立排入准确新文字');
        if (removed.generationNote) operations.push(removed.generationNote);
      }
    }
  }
  const route: ArtworkRouteDecision = { route: executedMethod === 'generate' || executedMethod === 'redraw' ? 'model' : 'fidelity', label: `${{ preserve: 'A 原图保真', redraw: 'B 原设计重建', compose: 'C 图文组合', generate: 'D 整图生成' }[executedMethod]}`, reasons: [decision.reason, ...operations], userOverride: request.processingRoute !== 'auto' };
  const resolution = assessArtworkResolution({ subjectWidth: source.subjectWidth, subjectHeight: source.subjectHeight });
  if (executedMethod === 'compose' && (intent.hasStyleReference || intent.specialTypography) && request.exactText.trim()) route.route = 'hybrid';
  const componentPlan = buildArtworkComponentPlan({ request, resolution, route });
  const metadata = await sharp(graphic).metadata();
  let draft = executedMethod === 'generate' ? createLegacyArtworkDraft(dataUrl(graphic)) : artworkDraftFromPreparedGraphic({
    graphicDataUrl: dataUrl(graphic), recolorMaskUrl: pixelRecolor ? null : await createArtworkRecolorMask(graphic, request.instruction).then(mask => mask ? dataUrl(mask) : null), graphicWidth: metadata.width!, graphicHeight: metadata.height!,
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
    draft.graphic.recolor = !pixelRecolor && color && draft.graphic.recolorMaskUrl ? { mode: 'solid', color } : { mode: 'original', color: null };
  }
  const primaryCutoutReceipt = cutoutReceipt;
  if (route.route === 'hybrid') {
    const styledTexts = [];
    for (const [index, text] of prompts.styledTexts.entries()) {
      progress(`正在制作并核对文字“${text.text}”…`);
      const generated = await prepareComponent(text.prompt, request.referenceImages.filter(reference => !request.fontReference || reference.label === request.fontReference.label).map(reference => reference.image.dataUrl), `styled-text-${index}`, async bytes => {
        const verification = await timed('textComponentVerification', () => services.verifyText(bytes, text.text));
        if (verification.outputSha256 !== artworkSha256(bytes) || verification.targetText !== text.text) throw new Error('文字组件核对没有对应当前图片与目标文字');
        textComposition.components.push(verification);
        if (verification.status !== 'passed') reviewWarnings.push(verification.status === 'uncertain' ? ARTWORK_UNCERTAIN_WARNING : `文字组件可能有误：${verification.evidence}`);
      });
      if (generated.generationNote) operations.push(generated.generationNote);
      const bytes = generated.bytes;
      const size = await sharp(bytes).metadata();
      styledTexts.push({ id: componentPlan.texts[index].id, value: text.text, sourceUrl: dataUrl(bytes), recolorMaskUrl: dataUrl(bytes), width: size.width!, height: size.height! });
      model = generated.model;
      usedPrompt = [usedPrompt, text.prompt].filter(Boolean).join('\n\n');
    }
    const preset = draft.layout.preset;
    const vertical = preset === 'vertical' || preset === 'verticalReverse';
    draft = createHybridArtworkDraft({ primaryGraphic: draft.graphic, styledTexts, sequence: componentPlan.sequence, preprocessing: draft.preprocessing });
    // Retain the requested direction so the print fitter can arrange visible
    // component edges instead of treating equally spaced centers as a manual layout.
    draft.layout.preset = preset;
    if (vertical) {
      const maximumHeight = 1024 / (componentPlan.sequence.length + 1) * .8;
      const position = (graphic: typeof draft.graphic) => {
        const scale = Math.min(1, maximumHeight / graphic.height);
        return { ...graphic, x: 512, y: graphic.x, width: graphic.width * scale, height: graphic.height * scale };
      };
      draft.graphic = position(draft.graphic);
      draft.extraGraphics = draft.extraGraphics?.map(position);
    }
    operations.push(`C 特殊字形生成 ${styledTexts.length} 个组件，逐一核对后程序合成，核对疑点作为提醒`);
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
  reviewWarnings.push(...cutoutWarnings);
  if (graphicQuality.requiredScale > 1) reviewWarnings.push(`最终主体 ${graphicQuality.subjectWidth}×${graphicQuality.subjectHeight}px，参考目标 ${graphicQuality.targetLongEdge ?? 1000}px；像素仍低于参考值，可继续使用，请人工核查细节。`);
  const actualPromptHash = usedPrompt ? artworkPromptHash(usedPrompt) : prompts.hash;
  const report: ArtworkRoutingReport = { version: ARTWORK_ROUTING_STANDARD.version, runId, requestHash: prompts.hash, sourceSha256: artworkSha256(originalSourceBytes), sourceSelection: selectedSource.receipt, decision, graphicDecision, executedMethod, graphicMethod,
    facts, source, repair, graphic: graphicQuality, reviewReasons, operations, model, prompt: usedPrompt, promptHash: actualPromptHash, timings: [...timings], ...(redraw ? { redraw } : {}),
    ...(executedMethod === 'compose' ? { textComposition } : {}),
    ...((editVerification || reviewWarnings.length) ? { contentReview: { verification: editVerification, warnings: [...new Set(reviewWarnings)] } } : {}) };
  await services.saveImage(runId, 'prepared-graphic', graphic);
  await services.saveReport(report);
  progress('图案处理完成，正在保存文件…', true);
  draft.preprocessing = { ...draft.preprocessing, referenceColor, cutout: primaryCutoutReceipt, cutoutRuns, backgroundRemoval, edgeRefinement, routingReport: report, processingRoute: route.route, routeReasons: route.reasons, generationModel: model, resolvedPrompt: usedPrompt, promptVersion: prompts.version, promptHash: actualPromptHash, imageMapping: prompts.imageMapping };
  return { status: 'prepared', draft, preprocessing: { timings: [...timings], cutout: primaryCutoutReceipt, cutoutRuns, nativeOutput: executedMethod === 'generate' && backgroundRemoval === 'none', modelLayoutPreserved: modelPreparation && executedMethod !== 'compose', edgeRefinement, evaluation: evaluation(source), enhancement, backgroundRemoval, sourceKind: sourceProfile.kind, resolution,
    maskQuality: await alphaMaskReport(graphic), decisionRule: [...operations, ...reviewReasons, ...reviewWarnings].join('；'), route, generationModel: model, componentPlan, resolvedPrompt: usedPrompt, promptVersion: prompts.version, promptHash: actualPromptHash, imageMapping: prompts.imageMapping } };
  } catch (error) {
    if (error instanceof NativeArtworkCandidateError || !availableCandidate) throw error;
    throw new NativeArtworkCandidateError({ ...availableCandidate,
      reason: `当前图案后续处理未完成：${error instanceof Error ? error.message : String(error)}。图片已保留，可放大查看或下载。` });
  }
}
