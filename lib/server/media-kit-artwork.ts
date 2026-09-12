import { artworkProtectionPolicy, type ArtworkProtectionPolicy } from '@/lib/artwork-protection';
import { assertArtworkMask } from './artwork-panel-mask';
import { downloadArtworkResult } from './artwork-result-download';
import { artworkJobStep, withArtworkStage, hasArtworkJobContext } from './artwork-job-runtime';
import { artworkPrintInstruction } from '@/lib/production-artwork-layout';
import sharp from 'sharp';
import { refineCircularArtworkEdge } from '@/lib/server/circular-artwork-edge';
import { withArtworkNetworkContext } from './artwork-network-error';

import {
  createHybridArtworkDraft,
  createLegacyArtworkDraft,
} from '@/lib/artwork-editor';
import type { LogoStudioInputImage, LogoStudioRequest } from '@/lib/logo-studio';
import {
  generateStyledTextArtwork,
  runLogoStudio,
} from '@/lib/server/ark-logo-studio';
import {
  applyArtworkAlphaMask,
  alphaMaskReport,
  createArtworkRecolorMask,
  inspectArtworkSource,
  mediaKitStandardInputSize,
  removeFlatArtworkBackground,
  visibleArtworkBounds,
  type ArtworkPixelBounds,
  type RgbColor,
} from '@/lib/server/artwork-image-processing';
import {
  assessArtworkResolution,
  artworkDraftFromPreparedGraphic,
  buildCanonicalArtworkModelPrompt,
  buildArtworkComponentPlan,
  decideArtworkProcessingRoute,
  recommendedEnhancement,
  type ArtworkEnhancementMode,
  type ArtworkPreparationRequest,
  type ArtworkPreparationResponse,
  type ArtworkQualityEvaluation,
  type ArtworkRouteDecision,
} from '@/lib/task-review-artwork';

const MEDIA_KIT_ORIGIN = 'https://mediakit.cn-beijing.volces.com';

const MAX_EMBEDDED_PNG_BYTES = 3 * 1024 * 1024;

type MediaKitResult = Record<string, unknown>;

function mediaKitApiKey() {
  const key = process.env.MEDIAKIT_API_KEY?.trim();
  if (!key) {
    throw new Error('MEDIAKIT_API_KEY is not configured；请在 AI MediaKit 控制台创建独立 API Key');
  }
  return key;
}

function dataUrlBuffer(dataUrl: string) {
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('图案素材 Data URL 缺少 Base64 内容');
  const bytes = Buffer.from(dataUrl.slice(separator + 1), 'base64');
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new Error(`MediaKit 输入图片必须在 1B–10MB，实际 ${bytes.length}B`);
  }
  return bytes;
}

function mediaKitFailure(label: string, status: number, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Error(`${label}失败：HTTP ${status}，响应不是对象`);
  }
  const response = body as Record<string, unknown>;
  const requestId = typeof response.request_id === 'string' ? response.request_id : '';
  const error = response.error && typeof response.error === 'object' && !Array.isArray(response.error)
    ? response.error as Record<string, unknown>
    : null;
  const code = typeof error?.code === 'string' ? error.code : `HTTP_${status}`;
  const message = typeof error?.message === 'string' ? error.message : '未返回详细错误';
  return new Error(`${label}失败：${code} · ${message}${requestId ? ` · request_id=${requestId}` : ''}`);
}

async function mediaKitPost(path: string, body: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
  // Upload tickets are unique per input; never memoize their empty request body.
  if (path.includes('request-media-upload-url')) return rawMediaKitPost(path, body, label);
  if (path.includes('remove-image-background')) return withArtworkStage('cutout', () => rawMediaKitPost(path, body, label));
  if (path.includes('evaluate-image-quality')) return withArtworkStage('quality', () => rawMediaKitPost(path, body, label));
  return artworkJobStep(`mediakit:${path}`, 'processing', body, () => rawMediaKitPost(path, body, label), true, path.includes('enhance-image'));
}
async function rawMediaKitPost(path: string, body: Record<string, unknown>, label: string) {
  const response = await withArtworkNetworkContext(label, () => fetch(`${MEDIA_KIT_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mediaKitApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  }));
  let responseBody: unknown;
  try {
    responseBody = await withArtworkNetworkContext(`${label}读取响应`, () => response.json());
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${label}返回无效 JSON：HTTP ${response.status}`);
  }
  if (!response.ok
    || !responseBody
    || typeof responseBody !== 'object'
    || Array.isArray(responseBody)
    || (responseBody as Record<string, unknown>).success !== true) {
    throw mediaKitFailure(label, response.status, responseBody);
  }
  return responseBody as Record<string, unknown>;
}

function resultObject(body: Record<string, unknown>, label: string) {
  if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
    throw new Error(`${label}响应缺少 result`);
  }
  return body.result as MediaKitResult;
}

function resultText(result: MediaKitResult, field: string, label: string) {
  const value = result[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}响应缺少 result.${field}`);
  return value;
}

function resultNumber(result: MediaKitResult, field: string, label: string) {
  const value = result[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}响应缺少 result.${field}`);
  return value;
}

function uploadHeaders(value: unknown) {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const header = candidate as Record<string, unknown>;
    const name = typeof header.key === 'string'
      ? header.key
      : typeof header.name === 'string'
        ? header.name
        : null;
    const headerValue = typeof header.value === 'string' ? header.value : null;
    return name && headerValue ? [[name, headerValue]] : [];
  }));
}

async function uploadImage(bytes: Buffer, mimeType: string): Promise<string> {
  // Upload I/O must not hold a processing slot while another stage waits for it.
  return artworkJobStep('mediakit-upload', 'processing', { bytes, mimeType }, () => rawUploadImage(bytes, mimeType), false);
}
async function rawUploadImage(bytes: Buffer, mimeType: string) {
  const uploadRequest = await mediaKitPost(
    '/api/v1/tools-sync/request-media-upload-url',
    {},
    'MediaKit 申请上传地址',
  );
  const result = resultObject(uploadRequest, 'MediaKit 申请上传地址');
  const uploadUrl = resultText(result, 'upload_url', 'MediaKit 申请上传地址');
  const fileId = resultText(result, 'file_id', 'MediaKit 申请上传地址');
  if (!fileId.startsWith('mediakit://')) throw new Error(`MediaKit file_id 协议不正确：${fileId.slice(0, 40)}`);
  const response = await withArtworkNetworkContext('MediaKit 上传图片', () => fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      ...uploadHeaders(result.upload_headers),
      'Content-Type': mimeType,
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(120_000),
  }));
  if (!response.ok) throw new Error(`MediaKit 上传图片失败：HTTP ${response.status}`);
  return fileId;
}

async function evaluateImage(imageUrl: string): Promise<ArtworkQualityEvaluation> {
  const body = await mediaKitPost('/api/v1/tools-sync/evaluate-image-quality', {
    image_url: imageUrl,
    tool_version: 'standard',
    standard_evaluate_items: ['vqscore', 'blur', 'noise', 'cmartifacts'],
  }, 'MediaKit 图像画质评估');
  const result = resultObject(body, 'MediaKit 图像画质评估');
  return {
    vqscore: resultNumber(result, 'vqscore', 'MediaKit 图像画质评估'),
    blur: resultNumber(result, 'blur', 'MediaKit 图像画质评估'),
    noise: typeof result.noise === 'number' ? result.noise : null,
    compressionArtifacts: typeof result.cmartifacts === 'number' ? result.cmartifacts : null,
  };
}

export async function evaluateArtworkBytes(bytes: Buffer) {
  return evaluateImage(await uploadImage(bytes, 'image/png'));
}

export async function removeArtworkBackgroundWithApi(bytes: Buffer, options: { scene?: 'product' | 'general'; crop?: boolean } = {}) {
  return downloadArtworkBackgroundRemoval(await submitArtworkBackgroundRemoval(bytes, options));
}

/** Persist submission intent after upload and persist the returned URL before download. */
export async function submitArtworkBackgroundRemoval(bytes: Buffer, options: { scene?: 'product' | 'general'; crop?: boolean; beforeSubmit?: () => Promise<void> } = {}) {
  const uploaded = await uploadImage(bytes, 'image/png');
  await options.beforeSubmit?.();
  return transparentImageUrl(uploaded, options);
}

export async function downloadArtworkBackgroundRemoval(url: string) {
  return downloadResult(url, 'MediaKit 图案去底');
}

async function enhancedImageUrl(
  imageUrl: string,
  enhancement: 'standard' | 'professional',
) {
  const body = await mediaKitPost('/api/v1/tools-sync/enhance-image', {
    image_url: imageUrl,
    tool_version: enhancement,
    multiple: 2,
    ...(enhancement === 'professional' ? { generative_enhance_mode: 'fidelity_first' } : {}),
  }, `MediaKit ${enhancement === 'standard' ? '标准' : '专业保真'}画质增强`);
  return resultText(resultObject(body, 'MediaKit 画质增强'), 'image_url', 'MediaKit 画质增强');
}

async function transparentImageUrl(imageUrl: string, options: { scene?: 'product' | 'general'; crop?: boolean } = {}) {
  const scene = options.scene ?? 'product';
  const body = await mediaKitPost('/api/v1/tools-sync/remove-image-background', {
    image_url: imageUrl,
    scene,
    ...(scene === 'product' ? { need_contour: false, need_crop_background: options.crop ?? true } : {}),
    output_format: 'png',
  }, `MediaKit ${scene === 'product' ? '商品主体' : '通用'}背景移除`);
  return resultText(resultObject(body, 'MediaKit 商品主体背景移除'), 'image_url', 'MediaKit 商品主体背景移除');
}

async function downloadResult(url: string, label: string) {
  return artworkJobStep('downloadResult-v1', 'processing', { url }, () => downloadArtworkResult(url, label), false);
}

async function normalizedGraphic(
  bytes: Buffer,
  requireTransparentBackground: boolean,
  strictMaskQuality: boolean,
  protection?: ArtworkProtectionPolicy,
) {
  const maskQuality = requireTransparentBackground ? await alphaMaskReport(bytes) : null;
  if (maskQuality) {
    if (strictMaskQuality) await assertArtworkMask(bytes, protection);
    else if (maskQuality.visibleRatio < 0.005) throw new Error('透明图案没有足够的可见主体像素');
  }
  const normalized = requireTransparentBackground
    ? await sharp(bytes)
        .ensureAlpha()
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .extend({
          top: 24,
          right: 24,
          bottom: 24,
          left: 24,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toBuffer()
    : await sharp(bytes).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
  // Durable jobs store image bytes in object storage, so the old inline HTTP
  // response cap must not silently shrink an enhanced production image.
  if (hasArtworkJobContext()) {
    if (normalized.length > 8 * 1024 * 1024) throw new Error('增强图超过当前 8MB 图层限制，原结果已保留，请下载原图；未缩小冒充高清成品');
    const metadata = await sharp(normalized).metadata();
    return { bytes: normalized, width: metadata.width!, height: metadata.height!, maskQuality };
  }
  let embedded = normalized;
  for (const maximumDimension of [1600, 1280, 1024]) {
    if (embedded.length <= MAX_EMBEDDED_PNG_BYTES) break;
    embedded = await sharp(normalized)
      .resize({ width: maximumDimension, height: maximumDimension, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  if (embedded.length > MAX_EMBEDDED_PNG_BYTES) {
    throw new Error(`MediaKit 透明图形压缩后仍有 ${embedded.length}B，超过正式接口 3MB 响应上限`);
  }
  const metadata = await sharp(embedded).metadata();
  if (!metadata.width || !metadata.height) throw new Error('MediaKit 透明图层缺少尺寸');
  return { bytes: embedded, width: metadata.width, height: metadata.height, maskQuality };
}

async function subjectEnhancementInput(
  sourceBytes: Buffer,
  alphaMaskBytes: Buffer,
  subjectBounds: ArtworkPixelBounds,
  backgroundColor: RgbColor,
) {
  const sourceMetadata = await sharp(sourceBytes).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) throw new Error('主体增强原图缺少可识别尺寸');
  const padding = Math.max(16, Math.ceil(Math.max(subjectBounds.width, subjectBounds.height) * 0.04));
  const left = Math.max(0, subjectBounds.left - padding);
  const top = Math.max(0, subjectBounds.top - padding);
  const right = Math.min(sourceMetadata.width, subjectBounds.left + subjectBounds.width + padding);
  const bottom = Math.min(sourceMetadata.height, subjectBounds.top + subjectBounds.height + padding);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth < 1 || cropHeight < 1) {
    throw new Error(`Logo 主体裁剪范围无效：left=${left}, top=${top}, width=${cropWidth}, height=${cropHeight}`);
  }
  let imageBytes = await sharp(sourceBytes)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .flatten({ background: backgroundColor })
    .png({ compressionLevel: 9 })
    .toBuffer();
  let maskBytes = await sharp(alphaMaskBytes)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
  const downscale = Math.min(1, 2048 / Math.max(cropWidth, cropHeight));
  let width = Math.max(1, Math.round(cropWidth * downscale));
  let height = Math.max(1, Math.round(cropHeight * downscale));
  if (downscale < 1) {
    imageBytes = await sharp(imageBytes)
      .resize({ width, height, fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    maskBytes = await sharp(maskBytes)
      .resize({ width, height, fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  const canvasWidth = Math.max(256, width);
  const canvasHeight = Math.max(256, height);
  if (canvasWidth !== width || canvasHeight !== height) {
    const leftPadding = Math.floor((canvasWidth - width) / 2);
    const rightPadding = canvasWidth - width - leftPadding;
    const topPadding = Math.floor((canvasHeight - height) / 2);
    const bottomPadding = canvasHeight - height - topPadding;
    imageBytes = await sharp(imageBytes)
      .extend({
        left: leftPadding,
        right: rightPadding,
        top: topPadding,
        bottom: bottomPadding,
        background: { ...backgroundColor, alpha: 1 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    maskBytes = await sharp(maskBytes)
      .extend({
        left: leftPadding,
        right: rightPadding,
        top: topPadding,
        bottom: bottomPadding,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    width = canvasWidth;
    height = canvasHeight;
  }
  return { imageBytes, maskBytes, width, height };
}

async function standardEnhancementInput(
  sourceBytes: Buffer,
  sourceFileId: string,
  width: number,
  height: number,
) {
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  if (shortEdge < 16) throw new Error(`标准增强要求输入短边至少 16px，实际 ${shortEdge}px`);
  if (shortEdge <= 1440 && longEdge <= 2160) return sourceFileId;
  const target = mediaKitStandardInputSize(width, height);
  const resized = await sharp(sourceBytes)
    .resize({ width: target.width, height: target.height, fit: 'fill', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return uploadImage(resized, 'image/png');
}

function explicitEnhancement(mode: ArtworkEnhancementMode) {
  return mode === 'auto' ? null : mode;
}

function requiresBrandGeometryPreservation(request: ArtworkPreparationRequest, sourceKind: string) {
  return sourceKind === 'flat-background'
    || sourceKind === 'transparent'
    || /logo|校徽|徽标|标志|商标|院徽|文字/iu.test(`${request.instruction}\n${request.layoutNote}`);
}

function assertWholeImageWasExplicitlyRequested(request: ArtworkPreparationRequest) {
  if (request.sourceScope !== 'wholeImage') return;
  if (/整张|整图|原样|保留背景|完整图案|完整素材/iu.test(request.instruction)) return;
  throw new Error(`sourceScope=wholeImage 必须有明确的整图原样使用要求；当前要求：${request.instruction}`);
}

function modelRequestForArtwork(
  request: ArtworkPreparationRequest,
): LogoStudioRequest {
  const canonical = buildCanonicalArtworkModelPrompt({
    sourceRequirementText: request.sourceRequirementText,
    printPlacement: request.printPlacement,
    instruction: request.instruction,
    exactText: request.exactText,
    layoutNote: request.layoutNote,
    sourceScope: request.sourceScope,
    primaryImageLabel: request.primaryImageLabel,
    referenceImageLabels: request.referenceImages.map((reference) => reference.label),
  });
  if (request.expectedPromptVersion && request.expectedPromptVersion !== canonical.version) {
    throw new Error(`页面制作要求版本已过期：页面为 ${request.expectedPromptVersion}，服务端为 ${canonical.version}，请刷新后重试`);
  }
  if (request.expectedPromptHash && request.expectedPromptHash !== canonical.promptHash) {
    throw new Error(`页面显示的制作要求与服务端最终要求不一致：页面为 ${request.expectedPromptHash}，服务端为 ${canonical.promptHash}，已停止生图`);
  }
  const imagesBySourceLabel = new Map<string, LogoStudioInputImage>([
    [request.primaryImageLabel, request.image],
    ...request.referenceImages.map((reference) => [reference.label, reference.image] as const),
  ]);
  const images = canonical.imageMapping.map((mapping) => {
    const image = imagesBySourceLabel.get(mapping.sourceLabel);
    if (!image) throw new Error(`canonical prompt 找不到 ${mapping.sourceLabel} 的模型输入图片`);
    return image;
  });
  return {
    images,
    instruction: canonical.prompt,
    generationPrompt: canonical.prompt,
    generationPromptVersion: canonical.version,
    generationPromptHash: canonical.promptHash,
    targetText: canonical.targetText,
    imageMapping: canonical.imageMapping,
  };
}

async function prepareModelArtwork(
  request: ArtworkPreparationRequest,
  route: ArtworkRouteDecision,
  sourceKind: ArtworkPreparationResponse['preprocessing']['sourceKind'],
  resolution: ArtworkPreparationResponse['preprocessing']['resolution'],
): Promise<ArtworkPreparationResponse> {
  const componentPlan = buildArtworkComponentPlan({ request, resolution, route });
  const result = await runLogoStudio(modelRequestForArtwork(request));
  if (result.status !== 'generated' || !result.generatedImage) {
    const questions = result.analysis.ambiguities.join('；') || '模型无法唯一确定素材、文字或排版关系';
    throw new Error(`模型路线需要人工补充：${questions}`);
  }
  const generatedBytes = dataUrlBuffer(result.generatedImage.dataUrl);
  const graphic = await normalizedGraphic(generatedBytes, true, false);
  const graphicDataUrl = `data:image/png;base64,${graphic.bytes.toString('base64')}`;
  const draft = createLegacyArtworkDraft(graphicDataUrl);
  const scale = Math.min(760 / graphic.width, 760 / graphic.height);
  draft.graphic.width = Math.max(1, Math.round(graphic.width * scale));
  draft.graphic.height = Math.max(1, Math.round(graphic.height * scale));
  draft.preprocessing = {
    ...draft.preprocessing,
    sourceKind,
    qualityLevel: resolution.level,
    subjectWidth: resolution.subjectWidth,
    subjectHeight: resolution.subjectHeight,
    requiredScale: resolution.requiredScale,
    processingRoute: route.route,
    routeReasons: route.reasons,
    routeOverride: route.userOverride,
    generationModel: result.generatedImage.model,
    componentSummary: componentPlan.summary,
    resolvedPrompt: result.resolvedPrompt,
    promptVersion: result.promptVersion,
    promptHash: result.promptHash,
    imageMapping: result.imageMapping,
  };
  return {
    status: 'prepared',
    draft,
    preprocessing: {
      evaluation: null,
      enhancement: 'none',
      backgroundRemoval: 'general',
      sourceKind,
      resolution,
      maskQuality: graphic.maskQuality,
      decisionRule: `${route.label}：${route.reasons.join('；')}`,
      route,
      generationModel: result.generatedImage.model,
      componentPlan,
      resolvedPrompt: result.resolvedPrompt,
      promptVersion: result.promptVersion,
      promptHash: result.promptHash,
      imageMapping: result.imageMapping,
    },
  };
}

async function prepareHybridArtwork(
  request: ArtworkPreparationRequest,
  route: ArtworkRouteDecision,
  sourceKind: ArtworkPreparationResponse['preprocessing']['sourceKind'],
  resolution: ArtworkPreparationResponse['preprocessing']['resolution'],
): Promise<ArtworkPreparationResponse> {
  const componentPlan = buildArtworkComponentPlan({ request, resolution, route });
  const styledTextComponents = componentPlan.texts.filter((text) => text.method === 'model-styled-text');
  if (styledTextComponents.length === 0) {
    throw new Error('混合处理没有识别到需要模型生成的特殊文字组件，请改用原图保真或补充字体参考');
  }
  const fidelityResult = await prepareTaskArtwork({
    ...request,
    exactText: '',
    layoutNote: '',
    referenceImages: [],
    processingRoute: 'fidelity',
  });
  const styledTextResults = await Promise.all(styledTextComponents.map(async (text) => {
    const referenceLabel = text.referenceLabels[0];
    const reference = request.referenceImages.find((candidate) => candidate.label === referenceLabel) ?? null;
    const generated = await generateStyledTextArtwork({
      text: text.value,
      styleInstruction: `${artworkPrintInstruction(request.printPlacement)}\n${reference
        ? `仅参考${reference.label}的字体笔触、粗细、倾斜、收笔和视觉气质；整体组件顺序由程序排版，不复制参考图中的其他图形、文字或位置关系。`
        : '保持清晰、适合工作服印花的特殊字形；整体组件顺序由程序排版。'}`,
      styleReference: reference?.image ?? null,
    });
    const normalized = await normalizedGraphic(dataUrlBuffer(generated.dataUrl), true, false);
    const dataUrl = `data:image/png;base64,${normalized.bytes.toString('base64')}`;
    return {
      id: text.id,
      value: text.value,
      sourceUrl: dataUrl,
      recolorMaskUrl: dataUrl,
      width: normalized.width,
      height: normalized.height,
      model: generated.model,
    };
  }));
  const generationModels = [...new Set(styledTextResults.map((result) => result.model))];
  const draft = createHybridArtworkDraft({
    primaryGraphic: fidelityResult.draft.graphic,
    styledTexts: styledTextResults,
    sequence: componentPlan.sequence,
    preprocessing: {
      ...fidelityResult.draft.preprocessing,
      processingRoute: 'hybrid',
      routeReasons: route.reasons,
      routeOverride: route.userOverride,
      generationModel: generationModels.join(', ') || null,
      componentSummary: componentPlan.summary,
    },
  });
  return {
    status: 'prepared',
    draft,
    preprocessing: {
      ...fidelityResult.preprocessing,
      sourceKind,
      resolution,
      decisionRule: `${route.label}：${route.reasons.join('；')}；${componentPlan.summary.join('；')}`,
      route,
      generationModel: generationModels.join(', ') || null,
      componentPlan,
    },
  };
}

async function graphicBytesAfterLocalBackgroundRemoval(
  bytes: Buffer,
  label: string,
) {
  const profile = await inspectArtworkSource(bytes);
  if (profile.kind === 'transparent') return bytes;
  if (profile.kind !== 'flat-background' || !profile.backgroundColor) {
    throw new Error(`${label}背景不再是可靠纯色，为防止损坏 Logo 已停止自动抠图`);
  }
  return removeFlatArtworkBackground(bytes, profile.backgroundColor);
}

export async function prepareTaskArtwork(
  request: ArtworkPreparationRequest,
  options?: { measuredQuality: ArtworkQualityEvaluation | null; cutout?: (bytes: Buffer) => Promise<Buffer> },
): Promise<ArtworkPreparationResponse> {
  assertWholeImageWasExplicitlyRequested(request);
  const sourceBytes = dataUrlBuffer(request.image.dataUrl);
  const sourceProfile = await inspectArtworkSource(sourceBytes);
  const shouldRemoveBackground = request.sourceScope !== 'wholeImage';
  const localFlatCutout = sourceProfile.kind === 'flat-background' && shouldRemoveBackground
    ? await graphicBytesAfterLocalBackgroundRemoval(sourceBytes, '原始平面 Logo')
    : null;
  const subjectBounds = sourceProfile.kind === 'transparent'
    ? await visibleArtworkBounds(sourceBytes)
    : localFlatCutout
      ? await visibleArtworkBounds(localFlatCutout)
      : { left: 0, top: 0, width: sourceProfile.width, height: sourceProfile.height };
  const resolution = assessArtworkResolution({
    subjectWidth: subjectBounds.width,
    subjectHeight: subjectBounds.height,
  });
  const route = decideArtworkProcessingRoute({ request, resolution });
  if (route.route === 'hybrid') {
    return prepareHybridArtwork(request, route, sourceProfile.kind, resolution);
  }
  if (route.route === 'model') {
    return prepareModelArtwork(request, route, sourceProfile.kind, resolution);
  }
  const componentPlan = buildArtworkComponentPlan({ request, resolution, route });
  const croppedSubjectInput = shouldRemoveBackground
    && (sourceProfile.kind === 'flat-background' || sourceProfile.kind === 'transparent' || options?.cutout)
    ? await subjectEnhancementInput(
        sourceBytes,
        localFlatCutout ?? sourceBytes,
        subjectBounds,
        sourceProfile.backgroundColor ?? { r: 255, g: 255, b: 255 },
      )
    : null;
  const evaluationBytes = croppedSubjectInput?.imageBytes ?? sourceBytes;
  const evaluationWidth = croppedSubjectInput?.width ?? sourceProfile.width;
  const evaluationHeight = croppedSubjectInput?.height ?? sourceProfile.height;
  const quality: ArtworkQualityEvaluation | null = options && 'measuredQuality' in options ? options.measuredQuality : null;
  const preserveGeometry = requiresBrandGeometryPreservation(request, sourceProfile.kind);
  const override = explicitEnhancement(request.enhancementMode);
  const recommendation = !quality ? {
    level: resolution.level, enhancement: override ?? (resolution.requiredScale > 1 ? 'professional' as const : 'none' as const),
    decisionRule: '按主体实际像素决定保真增强，最多一次；不调用数字评分',
  } : recommendedEnhancement({
    sourceWidth: evaluationWidth,
    sourceHeight: evaluationHeight,
    resolution,
    quality,
    preserveGeometry,
  });
  const enhancement = override ?? recommendation.enhancement;
  if (enhancement === 'professional'
    && (Math.min(evaluationWidth, evaluationHeight) < 256
      || Math.max(evaluationWidth, evaluationHeight) > 2048)) {
    throw new Error(`专业保真增强要求短边≥256px且长边≤2048px，当前增强输入 ${evaluationWidth}×${evaluationHeight}px`);
  }
  // Reuse/geometry-only paths do not need an upload or any provider call.
  const sourceFileId = enhancement === 'none' ? request.image.dataUrl : await uploadImage(evaluationBytes, croppedSubjectInput ? 'image/png' : request.image.mimeType);
  const enhancementInputUrl = enhancement === 'standard'
    ? await standardEnhancementInput(
        evaluationBytes,
        sourceFileId,
        evaluationWidth,
        evaluationHeight,
      )
    : sourceFileId;
  const preparedImageUrl = enhancement === 'none'
    ? sourceFileId
    : await enhancedImageUrl(enhancementInputUrl, enhancement);
  let backgroundRemoval: 'none' | 'edge-connected' | 'product' = 'none';
  const fineStrokeGraphic = sourceProfile.kind === 'flat-background'
    && Math.min(subjectBounds.width, subjectBounds.height) < 128;
  const decisionRule = `${override ? `人工指定增强模式 ${override}；` : ''}${recommendation.decisionRule}${croppedSubjectInput ? `；增强前已按全部前景安全裁剪为 ${evaluationWidth}×${evaluationHeight}px` : ''}${fineStrokeGraphic ? '；保留细字原 Alpha，不自动加粗或清除小连通域' : ''}`;
  let graphicBytes: Buffer<ArrayBufferLike> = sourceBytes;
  let strictMaskQuality = false;

  if (options?.cutout && shouldRemoveBackground) {
    // The production pipeline selects enhancement from the original first.
    // Opaque inputs retain their background through enhancement so the selected
    // cutout provider works on the enhanced strokes, not an enlarged old mask.
    let cutoutInput = enhancement === 'none'
      ? sourceBytes
      : await downloadResult(preparedImageUrl, 'MediaKit 抠图前保真增强图');
    if (enhancement !== 'none') {
      const metadata = await sharp(cutoutInput).metadata();
      if (!metadata.width || !metadata.height) throw new Error('保真增强结果缺少图片尺寸');
      const drift = Math.abs((metadata.width / metadata.height) / (evaluationWidth / evaluationHeight) - 1);
      if (drift > .01) throw new Error(`保真增强后 Logo 长宽比变化 ${(drift * 100).toFixed(2)}%，超过 1% 结构门禁`);
    }
    if (enhancement !== 'none' && sourceProfile.kind === 'transparent') {
      cutoutInput = await applyArtworkAlphaMask(cutoutInput, croppedSubjectInput?.maskBytes ?? sourceBytes,
        croppedSubjectInput ? { r: 255, g: 255, b: 255 } : undefined);
    }
    graphicBytes = await options.cutout(cutoutInput);
    backgroundRemoval = 'product';
    strictMaskQuality = true;
  } else if (sourceProfile.kind === 'flat-background') {
    const enhancedBytes = enhancement === 'none'
      ? sourceBytes
      : await downloadResult(preparedImageUrl, 'MediaKit Logo 保真增强图');
    if (shouldRemoveBackground) {
      if (enhancement === 'none' && !localFlatCutout) {
        throw new Error('平面 Logo 未生成可用的本地去底结果');
      }
      graphicBytes = enhancement === 'none'
        ? localFlatCutout as Buffer
        : await applyArtworkAlphaMask(
            enhancedBytes,
            croppedSubjectInput?.maskBytes ?? localFlatCutout as Buffer,
            sourceProfile.backgroundColor ?? undefined,
            fineStrokeGraphic,
          );
      backgroundRemoval = 'edge-connected';
      strictMaskQuality = true;
    } else {
      graphicBytes = enhancedBytes;
    }
  } else if (sourceProfile.kind === 'transparent') {
    if (enhancement !== 'none') {
      const enhancedBytes = await downloadResult(preparedImageUrl, 'MediaKit 透明 Logo 保真增强图');
      graphicBytes = shouldRemoveBackground
        ? await applyArtworkAlphaMask(
            enhancedBytes,
            croppedSubjectInput?.maskBytes ?? sourceBytes,
            croppedSubjectInput ? { r: 255, g: 255, b: 255 } : undefined,
          )
        : enhancedBytes;
      strictMaskQuality = shouldRemoveBackground;
    }
  } else {
    if (shouldRemoveBackground) {
      const graphicResultUrl = await transparentImageUrl(enhancement === 'none' ? await uploadImage(sourceBytes, request.image.mimeType) : preparedImageUrl);
      graphicBytes = await downloadResult(graphicResultUrl, 'MediaKit 商品主体透明图层');
      backgroundRemoval = 'product';
      strictMaskQuality = true;
    } else if (enhancement !== 'none') {
      graphicBytes = await downloadResult(preparedImageUrl, 'MediaKit 完整图形图层');
    }
  }

  let edgeRefinement: string | undefined;
  if (shouldRemoveBackground && enhancement !== 'none' && !options?.cutout && sourceProfile.kind === 'flat-background') {
    const refined = await refineCircularArtworkEdge(graphicBytes, sourceProfile.backgroundColor ?? undefined);
    if (refined.report.applied) {
      graphicBytes = refined.bytes;
      edgeRefinement = `圆形外沿净边：去白边与毛边，保留圆内内容（${refined.report.version}）`;
    }
  }
  const requireTransparentBackground = shouldRemoveBackground;
  const graphic = await normalizedGraphic(
    graphicBytes,
    requireTransparentBackground,
    strictMaskQuality,
    artworkProtectionPolicy(request.instruction, request.layoutNote, request),
  );
  const recolorMaskBytes = request.sourceScope === 'wholeImage'
    ? null
    : await createArtworkRecolorMask(graphic.bytes, request.instruction);
  const graphicDataUrl = `data:image/png;base64,${graphic.bytes.toString('base64')}`;
  const recolorMaskUrl = recolorMaskBytes
    ? `data:image/png;base64,${recolorMaskBytes.toString('base64')}`
    : null;
  const draft = artworkDraftFromPreparedGraphic({
      graphicDataUrl,
      recolorMaskUrl,
      graphicWidth: graphic.width,
      graphicHeight: graphic.height,
      request,
      quality,
      enhancement,
      backgroundRemoval,
      sourceKind: sourceProfile.kind,
      resolution,
      route,
      componentPlan,
    });
  if (edgeRefinement) draft.preprocessing.edgeRefinement = edgeRefinement;
  return {
    status: 'prepared',
    draft,
    preprocessing: {
      edgeRefinement,
      evaluation: quality,
      enhancement,
      backgroundRemoval,
      sourceKind: sourceProfile.kind,
      resolution,
      maskQuality: graphic.maskQuality,
      decisionRule,
      route,
      generationModel: null,
      componentPlan,
      resolvedPrompt: null,
      promptVersion: null,
      promptHash: null,
      imageMapping: [],
    },
  };
}
