import { parseArtworkSourceAssessment } from './artwork-source-assessment';
import { compileGenerationPrompt, parseGenerationPrompt } from './artwork-generation-prompt';
import { artworkPrintInstruction, artworkPrintPlacementSchema, type ArtworkPrintPlacement } from './production-artwork-layout';
import { clarityFromStandardBlur } from '@/lib/artwork-routing-standard';
import {
  createStructuredArtworkDraft,
  inferredArtworkLayout,
  type ArtworkDraft,
} from '@/lib/artwork-editor';
import {
  parseLogoStudioRequest,
  type LogoStudioInputImage,
} from '@/lib/logo-studio';
import type { SourceScope } from '@/lib/batch-task-review';
import type { ArtworkProcessingRouteMode } from '@/lib/batch-task-review';
import type {
  ArtworkAlphaMaskReport,
  ArtworkSourceKind,
} from '@/lib/server/artwork-image-processing';

export type ArtworkEnhancementMode = 'auto' | 'none' | 'standard' | 'professional';
export type ArtworkProcessingRoute = Exclude<ArtworkProcessingRouteMode, 'auto'>;

export type ArtworkReferenceImage = {
  label: string;
  image: LogoStudioInputImage;
};

export type ArtworkRouteDecision = {
  route: ArtworkProcessingRoute;
  label: string;
  reasons: string[];
  userOverride: boolean;
};

export type ArtworkComponentMethod =
  | 'fidelity-graphic'
  | 'model-rebuild-graphic'
  | 'deterministic-text'
  | 'deterministic-transform'
  | 'model-styled-text'
  | 'reference-only';

export type ArtworkComponentPlan = {
  graphic: {
    label: string;
    method: 'fidelity-graphic' | 'model-rebuild-graphic';
  };
  texts: Array<{
    id: string;
    value: string;
    method: 'deterministic-text' | 'deterministic-transform' | 'model-styled-text';
    referenceLabels: string[];
  }>;
  references: Array<{
    label: string;
    method: 'reference-only';
    roles: Array<'style' | 'layout'>;
  }>;
  sequence: Array<{ kind: 'graphic'; label: string } | { kind: 'text'; id: string }>;
  summary: string[];
};

export type ArtworkCompositionDescription = {
  textSegments: string[];
  sequence: Array<{ kind: 'graphic'; label: string } | { kind: 'text'; value: string }>;
  summary: string[];
  description: string;
};

export type ArtworkPreparationRequest = {
  cutoutMode?: import('@/lib/artwork-cutout').ArtworkCutoutMode;
  generationPrompt?: string;
  artworkMethod?: 'auto' | 'preserve' | 'redraw' | 'compose' | 'generate';
  printPlacement?: ArtworkPrintPlacement;
  sourceAssessment?: import('./artwork-source-assessment').ArtworkSourceAssessment;
  sourceRequirementText: string;
  instruction: string;
  exactText: string;
  layoutNote: string;
  image: LogoStudioInputImage;
  primaryImageLabel: string;
  primaryImageRole?: 'content' | 'reference';
  referenceImages: ArtworkReferenceImage[];
  enhancementMode: ArtworkEnhancementMode;
  sourceScope: SourceScope;
  processingRoute: ArtworkProcessingRouteMode;
  expectedPromptVersion?: string;
  expectedPromptHash?: string;
};

export const ARTWORK_MODEL_PROMPT_VERSION = 'task-review-artwork-v10';

export type NativeArtworkCandidate = { runId: string; url: string; model: string; reason: string; promptHash: string; stage?: 'edit-review'; requiresEditVerification?: boolean; cutout?: import('@/lib/artwork-cutout').ArtworkCutoutResult };

export type ArtworkModelImageMapping = {
  sourceLabel: string;
  modelInputLabel: string;
  role: 'content' | 'reference';
  requirement: string;
};

export type CanonicalArtworkModelPrompt = {
  version: typeof ARTWORK_MODEL_PROMPT_VERSION;
  prompt: string;
  promptHash: string;
  targetText: string;
  imageMapping: ArtworkModelImageMapping[];
};

export type CanonicalArtworkModelPromptInput = {
  sourceAssessment?: import('./artwork-source-assessment').ArtworkSourceAssessment;
  primaryImageRole?: 'content' | 'reference';
  generationPrompt?: string;
  printPlacement?: ArtworkPrintPlacement;
  sourceRequirementText: string;
  instruction: string;
  exactText: string;
  layoutNote: string;
  sourceScope: SourceScope;
  primaryImageLabel: string;
  referenceImageLabels: string[];
};

export type ArtworkQualityEvaluation = {
  vqscore: number;
  /** Raw MediaKit standard severity, 0 = least blur, 100 = most blur. */
  blur: number;
  noise: number | null;
  compressionArtifacts: number | null;
};

export type ArtworkQualityLevel = 'usable' | 'low' | 'severe';

export type ArtworkResolutionAssessment = {
  level: ArtworkQualityLevel;
  subjectWidth: number;
  subjectHeight: number;
  targetLongEdge: number;
  requiredScale: number;
};

export type ArtworkPreparationResponse = {
  status: 'prepared';
  draft: ArtworkDraft;
  preprocessing: {
    timings?: import('./artwork-progress').ArtworkTiming[];
    cutout?: import('@/lib/artwork-cutout').ArtworkCutoutReceipt;
    cutoutRuns?: import('@/lib/artwork-cutout').ArtworkCutoutReceipt[];
    nativeOutput?: boolean;
    modelLayoutPreserved?: boolean;
    edgeRefinement?: string;
    evaluation: ArtworkQualityEvaluation | null;
    enhancement: 'none' | 'standard' | 'professional';
    backgroundRemoval: 'none' | 'edge-connected' | 'product' | 'general';
    sourceKind: ArtworkSourceKind;
    resolution: ArtworkResolutionAssessment;
    maskQuality: ArtworkAlphaMaskReport | null;
    decisionRule: string;
    route: ArtworkRouteDecision;
    generationModel: string | null;
    componentPlan: ArtworkComponentPlan;
    resolvedPrompt: string | null;
    promptVersion: string | null;
    promptHash: string | null;
    imageMapping: ArtworkModelImageMapping[];
  };
};

const ENHANCEMENT_MODES: ArtworkEnhancementMode[] = ['auto', 'none', 'standard', 'professional'];
const SOURCE_SCOPES: SourceScope[] = ['subject', 'subjectWithFrame', 'wholeImage', 'custom'];
const PROCESSING_ROUTES: ArtworkProcessingRouteMode[] = ['auto', 'fidelity', 'hybrid', 'model'];

function numericImageLabel(label: string) {
  const match = label.match(/^图([1-9]|[12][0-9]|30)$/u);
  if (!match) throw new Error(`素材图号必须是图1–图30，实际为 ${label}`);
  return Number(match[1]);
}

function stablePromptHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sourceScopeRequirement(sourceScope: SourceScope) {
  if (sourceScope === 'wholeImage') {
    return '完整保留主要素材中的全部图形、文字和内部框架；只有客户明确要求删除的内容才可删除。';
  }
  if (sourceScope === 'subjectWithFrame') {
    return '去掉画布背景，保留主要图形及其内部框架、边框、文字、装饰、细节和负形。';
  }
  if (sourceScope === 'custom') {
    return '严格按任务原文决定保留与删除范围；没有写明删除的前景元素不得擅自删除。';
  }
  return '只去掉与画布边缘连通的背景或底色；保留全部非背景前景元素，包括文字、边框、装饰、内部细节和负形。';
}

export function artworkModelInputLabels(input: Pick<
  CanonicalArtworkModelPromptInput,
  'primaryImageLabel' | 'referenceImageLabels'
>) {
  const labels = [input.primaryImageLabel, ...input.referenceImageLabels];
  labels.forEach(numericImageLabel);
  if (new Set(labels).size !== labels.length) {
    throw new Error(`模型输入素材图号不能重复：${labels.join('、')}`);
  }
  return [
    input.primaryImageLabel,
    ...input.referenceImageLabels.sort((left, right) => numericImageLabel(left) - numericImageLabel(right)),
  ];
}

export function buildCanonicalArtworkModelPrompt(
  input: CanonicalArtworkModelPromptInput,
): CanonicalArtworkModelPrompt {
  const instruction = input.instruction.trim();
  if (!instruction) throw new Error('canonical artwork prompt 缺少制作要求');
  const sourceRequirementText = input.sourceRequirementText.trim();
  if (!sourceRequirementText) throw new Error('canonical artwork prompt 缺少 WPS 原文');
  const exactText = input.exactText.trim();
  if (input.primaryImageRole === 'reference' && (!exactText || !input.generationPrompt?.trim())) throw new Error('请先填写准确文字并整理生图提示词');
  const layoutNote = input.layoutNote.trim();
  const orderedLabels = artworkModelInputLabels(input);
  const imageMapping = orderedLabels.map((sourceLabel, index): ArtworkModelImageMapping => {
    const contentSource = sourceLabel === input.primaryImageLabel && input.primaryImageRole !== 'reference';
    return {
      sourceLabel,
      modelInputLabel: `图${index + 1}`,
      role: contentSource ? 'content' : 'reference',
      requirement: input.generationPrompt?.trim() ? '具体取材和用途按生图提示词执行。' : contentSource
        ? '必须进入最终成品；保留客户指定的主体内容、品牌识别结构及其原有颜色。除非客户明确要求该 Logo 改色，否则禁止跟随参考图或新增文字统一改色。'
        : '只参考任务明确点名的属性：字体/字形、文字颜色、排版分别执行；未点名的属性不自动套用。先定位照片中被参考的印花区域；不得复制人物、衣服、场景、背景或无关文字。',
    };
  });
  if (input.generationPrompt?.trim()) {
    const compiled = compileGenerationPrompt(input.generationPrompt, imageMapping);
    const prompt = input.primaryImageRole === 'reference'
      ? `${compiled}\n\n【文字内容与参考边界】唯一允许出现的文字为 ${JSON.stringify(exactText)}，逐字准确。所有输入图片仅供字形、颜色或排版参考；不复制其原文字、标识内容、人物、服装、场景或界面。`
      : compiled;
    return { version: ARTWORK_MODEL_PROMPT_VERSION, prompt, promptHash: stablePromptHash(prompt), targetText: exactText, imageMapping };
  }
  const mappingLines = imageMapping.map((mapping) => (
    `- 模型输入${mapping.modelInputLabel} = WPS ${mapping.sourceLabel}；${mapping.role === 'content' ? '内容素材' : '参考素材'}：${mapping.requirement}`
  ));
  const targetTextRule = exactText
    ? `需要新增的准确文字为“${exactText}”；新增文字必须逐字、逐数字准确，不得增字、漏字、错字或改写。此限制只约束新增文字，不得删除或改写内容素材本身已有的品牌、校徽或标志文字。`
    : '客户没有要求新增文字，不得自行添加任何文字。';
  const layoutRule = layoutNote || 'WPS 原文没有提供更多排版细节，不得自行补充为客户要求。';
  const prompt = [
    '请生成一张用于后续抠图和工作服印制的独立二维完整图案。不要生成衣服、人物、模特、布料、商品展示、摄影场景或界面截图。',
    '',
    '【WPS 原文｜唯一客户事实】',
    sourceRequirementText,
    '',
    '【本生成单元的结构化解释｜系统生成】',
    instruction,
    '结构化解释只用于定位本单元，不能覆盖 WPS 原文，也不能补充原文没有的视觉要求。',
    '',
    '【模型输入图片映射】',
    ...mappingLines,
    '图片编号必须按上述映射理解，不得把模型输入图号误当成 WPS 原图号。',
    '',
    '【准确文字】',
    targetTextRule,
    '',
    '【构图与视觉】',
    layoutRule,
    '客户指定视觉属性参考某图，就以该图对应印花区域的可见特征作为该属性的依据。先辨认文字颜色、笔画粗细与收笔、字形风格，再绘制；不能只做到文字顺序和弧形相似而忽略已指定的字体、颜色。照片的衣服颜色不等于文字颜色。',
    '内容素材约束 Logo 自身的形状、细节和颜色；参考图约束客户点名的新增文字或整体排版。不得把内容 Logo 的红色、黑色或印刷字形自动套给新增文字。只参考颜色时不模仿字形；只参考排版时不借用配色。',
    '“参考图观察”是对指定图像区域的视觉解释，须与实际图片核对。看不清的细节不得编造具体字体名称或客户指定色号。',
    '只执行 WPS 原文和上述结构化解释中明确存在的关系；未说明的字号、比例、间距、对齐、层级和颜色不得冒充客户要求。',
    '',
    artworkPrintInstruction(input.printPlacement),
    '',
    '【素材范围】',
    input.sourceScope === 'wholeImage' ? sourceScopeRequirement(input.sourceScope)
      : '取用客户指定的图案前景，保留全部标志文字、边框、装饰与识别结构。Logo 内部的白色图形、白色圆环及其他内部细节保持原样；只去除图案外围与画布边缘连通的底色，不把内部白色挖空。',
    '参考素材只提供任务点名的参考信息，不得带入其人物、衣服、背景、截图边框、界面元素或无关文字。',
    '',
    '【输出要求】',
    '一次输出一个完整版本，不拆成多张图，不分别生成组件后拼接。',
    '边缘清晰，四周保留安全留白。颜色只按 WPS 原文明示执行；原文未指定时不得擅自写成客户指定颜色。',
    '输出纯白背景（#FFFFFF）的 PNG，背景均匀无纹理，不生成透明背景、棋盘格、网格、彩色底、阴影或底板。Logo 内部原有白色与其他细节保持原样。Logo、准确文字、字形与排版一次生成完成；后续由独立抠图步骤移除背景，不换色、不重新排字。',
  ].join('\n');
  return {
    version: ARTWORK_MODEL_PROMPT_VERSION,
    prompt,
    promptHash: stablePromptHash(prompt),
    targetText: exactText,
    imageMapping,
  };
}

function imageLabel(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^图(?:[1-9]|[12][0-9]|30)$/u.test(value.trim())) {
    throw new Error(`${field} 必须是图1–图30，实际为 ${String(value)}`);
  }
  return value.trim();
}

export function parseArtworkPreparationRequest(value: unknown): ArtworkPreparationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('图案准备请求必须是对象');
  }
  const input = value as Record<string, unknown>;
  const sourceRequirementText = typeof input.sourceRequirementText === 'string'
    ? input.sourceRequirementText.trim()
    : '';
  if (!sourceRequirementText) throw new Error('sourceRequirementText 必须是非空 WPS 原文');
  if (sourceRequirementText.length > 4_000) {
    throw new Error(`sourceRequirementText 最多 4000 个字符，实际 ${sourceRequirementText.length} 个`);
  }
  const exactText = typeof input.exactText === 'string' ? input.exactText.trim() : '';
  if (exactText.length > 200) throw new Error(`exactText 最多 200 个字符，实际 ${exactText.length} 个`);
  const layoutNote = typeof input.layoutNote === 'string' ? input.layoutNote.trim() : '';
  if (layoutNote.length > 500) throw new Error(`layoutNote 最多 500 个字符，实际 ${layoutNote.length} 个`);
  if (input.enhancementMode !== undefined
    && (typeof input.enhancementMode !== 'string'
      || !ENHANCEMENT_MODES.includes(input.enhancementMode as ArtworkEnhancementMode))) {
    throw new Error(`enhancementMode 不支持：${String(input.enhancementMode)}`);
  }
  const enhancementMode = (input.enhancementMode ?? 'auto') as ArtworkEnhancementMode;
  if (input.sourceScope !== undefined
    && (typeof input.sourceScope !== 'string' || !SOURCE_SCOPES.includes(input.sourceScope as SourceScope))) {
    throw new Error(`sourceScope 不支持：${String(input.sourceScope)}`);
  }
  const sourceScope = (input.sourceScope ?? 'subject') as SourceScope;
  if (input.processingRoute !== undefined
    && (typeof input.processingRoute !== 'string'
      || !PROCESSING_ROUTES.includes(input.processingRoute as ArtworkProcessingRouteMode))) {
    throw new Error(`processingRoute 不支持：${String(input.processingRoute)}`);
  }
  const processingRoute = (input.processingRoute ?? 'auto') as ArtworkProcessingRouteMode;
  if (input.artworkMethod !== undefined && !['auto', 'preserve', 'redraw', 'compose', 'generate'].includes(String(input.artworkMethod))) throw new Error('不支持的图案处理方式');
  const artworkMethod = input.artworkMethod as ArtworkPreparationRequest['artworkMethod'];
  if (input.cutoutMode !== undefined && !['auto', 'standard', 'meitu'].includes(String(input.cutoutMode))) throw new Error('cutoutMode 不支持');
  const expectedPromptVersion = typeof input.expectedPromptVersion === 'string'
    ? input.expectedPromptVersion.trim()
    : undefined;
  const expectedPromptHash = typeof input.expectedPromptHash === 'string'
    ? input.expectedPromptHash.trim()
    : undefined;
  if (expectedPromptVersion && expectedPromptVersion.length > 80) {
    throw new Error(`expectedPromptVersion 最多 80 个字符，实际 ${expectedPromptVersion.length} 个`);
  }
  if (expectedPromptHash && !/^fnv1a-[0-9a-f]{8}$/u.test(expectedPromptHash)) {
    throw new Error(`expectedPromptHash 格式无效：${expectedPromptHash}`);
  }
  const primaryImageLabel = input.primaryImageLabel === undefined
    ? '图1'
    : imageLabel(input.primaryImageLabel, 'primaryImageLabel');
  if (input.primaryImageRole !== undefined && input.primaryImageRole !== 'content' && input.primaryImageRole !== 'reference') throw new Error('primaryImageRole 必须是 content 或 reference');
  if (input.primaryImageRole === 'reference' && (!exactText.trim() || !parseGenerationPrompt(input.generationPrompt))) throw new Error('primaryImageRole 为 reference 时必须填写准确文字与生图提示词');
  if (input.referenceImages !== undefined && !Array.isArray(input.referenceImages)) {
    throw new Error('referenceImages 必须是数组');
  }
  const rawReferenceImages = (input.referenceImages ?? []) as unknown[];
  if (rawReferenceImages.length > 15) {
    throw new Error(`referenceImages 当前最多 15 张，实际 ${rawReferenceImages.length} 张`);
  }
  const referenceLabels = new Set<string>([primaryImageLabel]);
  const referenceCandidates = rawReferenceImages.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`referenceImages[${index}] 必须是对象`);
    }
    const record = candidate as Record<string, unknown>;
    const label = imageLabel(record.label, `referenceImages[${index}].label`);
    if (referenceLabels.has(label)) throw new Error(`参考素材图号重复：${label}`);
    referenceLabels.add(label);
    return { label, image: record.image };
  });
  const parsedImages = [input.image, ...referenceCandidates.map(candidate => candidate.image)].map(image => parseLogoStudioRequest({ instruction: input.instruction, images: [image] }));
  const parsed = { instruction: parsedImages[0].instruction, images: parsedImages.map(result => result.images[0]) };
  return {
    sourceRequirementText,
    generationPrompt: parseGenerationPrompt(input.generationPrompt),
    sourceAssessment: parseArtworkSourceAssessment(input.sourceAssessment),
    instruction: parsed.instruction,
    printPlacement: input.printPlacement === undefined ? undefined : artworkPrintPlacementSchema.parse(input.printPlacement),
    exactText,
    layoutNote,
    image: parsed.images[0],
    primaryImageLabel,
    ...(input.primaryImageRole ? { primaryImageRole: input.primaryImageRole as 'content' | 'reference' } : {}),
    referenceImages: referenceCandidates.map((candidate, index) => ({
      label: candidate.label,
      image: parsed.images[index + 1],
    })),
    enhancementMode,
    sourceScope,
    processingRoute,
    artworkMethod,
    cutoutMode: input.cutoutMode as ArtworkPreparationRequest['cutoutMode'],
    expectedPromptVersion,
    expectedPromptHash,
  };
}

const ARTWORK_GRAPHIC_TARGET_LONG_EDGE = 1000;

function worstQualityLevel(levels: ArtworkQualityLevel[]) {
  return levels.includes('severe') ? 'severe' : levels.includes('low') ? 'low' : 'usable';
}

export function assessArtworkResolution(input: {
  subjectWidth: number;
  subjectHeight: number;
  targetLongEdge?: number;
}): ArtworkResolutionAssessment {
  if (!Number.isFinite(input.subjectWidth) || input.subjectWidth < 1
    || !Number.isFinite(input.subjectHeight) || input.subjectHeight < 1) {
    throw new Error(`Logo 主体尺寸无效：${input.subjectWidth}×${input.subjectHeight}`);
  }
  const targetLongEdge = input.targetLongEdge ?? ARTWORK_GRAPHIC_TARGET_LONG_EDGE;
  if (!Number.isFinite(targetLongEdge) || targetLongEdge < 1) {
    throw new Error(`Logo 目标长边无效：${targetLongEdge}`);
  }
  const requiredScale = targetLongEdge / Math.max(input.subjectWidth, input.subjectHeight);
  return {
    level: requiredScale > 4 ? 'severe' : requiredScale > 1.25 ? 'low' : 'usable',
    subjectWidth: Math.round(input.subjectWidth),
    subjectHeight: Math.round(input.subjectHeight),
    targetLongEdge: Math.round(targetLongEdge),
    requiredScale: Number(requiredScale.toFixed(2)),
  };
}

const ROUTE_LABELS: Record<ArtworkProcessingRoute, string> = {
  fidelity: '原图保真',
  hybrid: '混合处理',
  model: '模型生成',
};

export function artworkIntent(request: Pick<ArtworkPreparationRequest, 'instruction' | 'layoutNote' | 'exactText' | 'primaryImageLabel'> & { referenceImages: Array<{ label: string }> }) {
  const requirement = `${request.instruction}\n${request.layoutNote}`;
  const hasReference = request.referenceImages.length > 0;
  const hasStyleReference = hasReference
    && request.exactText.length > 0
    && /参考|按照|同款|仿照|字体|字形|风格|笔触|书法|排版/iu.test(requirement);
  const wholeCompositionReference = requiresCompleteModelComposition({
    instruction: request.instruction,
    exactText: request.exactText,
    layoutNote: request.layoutNote,
    primaryImageLabel: request.primaryImageLabel,
    referenceImageLabels: request.referenceImages.map((reference) => reference.label),
  });
  const geometricTextTransform = /扇形|弧形|环形|沿弧/iu.test(requirement);
  const specialTypography = /书法|手写|艺术字|特殊字体|字形|笔触|参考.{0,12}(?:字体|字形|排版|风格)|(?:字体|字形|排版|风格).{0,12}参考/iu.test(requirement);
  const selectiveComposition = /前三排|前\s*[一二三四五六七八九十0-9]+排|截取|裁切|取.{0,8}部分/iu.test(requirement);
  return {
    geometricTextTransform,
    hasStyleReference,
    wholeCompositionReference,
    selectiveComposition,
    specialTypography,
  };
}

function cleanCompositionText(value: string) {
  const afterPlacement = value.split(/[：:]/u).at(-1) ?? value;
  return afterPlacement
    .replace(/^[\s“”'"‘’]+|[\s“”'"‘’，,。；;]+$/gu, '')
    .trim();
}

function compositionTextParts(input: {
  instruction: string;
  exactText: string;
  primaryImageLabel: string;
}) {
  const exactText = input.exactText.trim();
  if (!exactText) return [];
  const explicitLines = exactText.split(/\n+/u).map((part) => part.trim()).filter(Boolean);
  if (explicitLines.length > 1) return explicitLines;
  const whitespaceParts = exactText.split(/\s+/u).map((part) => part.trim()).filter(Boolean);
  if (whitespaceParts.length === 2) {
    const compactInstruction = compactCompositionValue(input.instruction);
    const firstTextIndex = compactInstruction.indexOf(compactCompositionValue(whitespaceParts[0]));
    const graphicIndex = compactInstruction.indexOf(compactCompositionValue(input.primaryImageLabel));
    const secondTextIndex = compactInstruction.indexOf(compactCompositionValue(whitespaceParts[1]));
    if (firstTextIndex >= 0 && graphicIndex > firstTextIndex && secondTextIndex > graphicIndex) {
      return whitespaceParts;
    }
  }
  const escapedLabel = input.primaryImageLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const aroundPrimary = input.instruction.match(new RegExp(
    `([^，。；;\\n]{1,60})\\+\\s*${escapedLabel}\\s*\\+\\s*([^，。；;\\n]{1,60})`,
    'iu',
  ));
  if (!aroundPrimary) return [exactText];
  const before = cleanCompositionText(aroundPrimary[1]);
  const after = cleanCompositionText(aroundPrimary[2]);
  const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');
  if (!before || !after || normalized(`${before}${after}`) !== normalized(exactText)) {
    return [exactText];
  }
  return [before, after];
}

function compactCompositionValue(value: string) {
  return value.normalize('NFKC').replace(/[\s“”'‘’，,。；;：:【】()[\]]+/gu, '');
}

function orderedCompositionSequence(input: {
  instruction: string;
  primaryImageLabel: string;
  textSegments: string[];
}) {
  const graphic = { kind: 'graphic' as const, label: input.primaryImageLabel };
  const texts = input.textSegments.map((value) => ({ kind: 'text' as const, value }));
  if (texts.length !== 2) return [graphic, ...texts];

  const compactInstruction = compactCompositionValue(input.instruction);
  const firstTextIndex = compactInstruction.indexOf(compactCompositionValue(texts[0].value));
  const graphicIndex = compactInstruction.indexOf(compactCompositionValue(input.primaryImageLabel));
  const secondTextIndex = compactInstruction.indexOf(compactCompositionValue(texts[1].value));
  return firstTextIndex >= 0 && graphicIndex > firstTextIndex && secondTextIndex > graphicIndex
    ? [texts[0], graphic, texts[1]]
    : [graphic, ...texts];
}

export function describeArtworkComposition(input: {
  instruction: string;
  exactText: string;
  layoutNote: string;
  primaryImageLabel: string;
  referenceImageLabels: string[];
}): ArtworkCompositionDescription {
  const textSegments = compositionTextParts(input);
  let sequence = orderedCompositionSequence({
    instruction: input.instruction,
    primaryImageLabel: input.primaryImageLabel,
    textSegments,
  });
  const requirement = `${input.instruction}\n${input.layoutNote}`;
  const layout = inferredArtworkLayout(requirement, input.exactText);
  if (textSegments.length === 1 && (layout === 'verticalReverse' || layout === 'horizontalReverse')) {
    sequence = [{ kind: 'text', value: textSegments[0] }, { kind: 'graphic', label: input.primaryImageLabel }];
  }
  const referenceRole = /字体|字形|风格|笔触|书法/iu.test(requirement)
    ? /排版|布局|位置/iu.test(requirement) ? '字体/风格与排版' : '字体/风格'
    : '排版';
  const sequenceLabel = sequence.map((component) => component.kind === 'graphic'
    ? `${component.label}主体`
    : `文字“${component.value}”`).join(' ＋ ');
  const referenceDescription = input.referenceImageLabels.length > 0
    ? `；${input.referenceImageLabels.join('、')}仅作${referenceRole}参考，不进入成品`
    : '';
  return {
    textSegments,
    sequence,
    summary: [
      `${input.primaryImageLabel}：进入成品的主体图形`,
      ...textSegments.map((value) => `文字“${value}”：进入成品的独立文字组件`),
      ...input.referenceImageLabels.map((label) => `${label}：仅作${referenceRole}参考，不进入成品`),
      `成品顺序：${sequenceLabel}`,
    ],
    description: `制作一张完整图案：${sequenceLabel}${referenceDescription}。`,
  };
}

export function compositionTextSegments(request: ArtworkPreparationRequest) {
  return describeArtworkComposition({
    instruction: request.instruction,
    exactText: request.exactText,
    layoutNote: request.layoutNote,
    primaryImageLabel: request.primaryImageLabel,
    referenceImageLabels: request.referenceImages.map((reference) => reference.label),
  }).textSegments;
}

export function requiresCompleteModelComposition(input: {
  instruction: string;
  exactText: string;
  layoutNote: string;
  primaryImageLabel: string;
  referenceImageLabels: string[];
}) {
  if (input.referenceImageLabels.length === 0) return false;
  const composition = describeArtworkComposition(input);
  if (composition.textSegments.length === 0) return false;
  const requirement = `${input.instruction}\n${input.layoutNote}`;
  const wholeCompositionCue = /(?:参考|按照|仿照|同款).{0,16}(?:整体|组合|一体|层级|比例|版式|排版|布局|位置关系)|(?:整体|组合|一体|层级|比例|版式|排版|布局|位置关系).{0,16}(?:参考|按照|仿照|同款)/iu;
  if (wholeCompositionCue.test(requirement)) return true;
  return input.referenceImageLabels.some((label) => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(
      `${escapedLabel}.{0,8}(?:决定|控制|参考|按照|仿照|同款).{0,20}(?:整体|组合|一体|层级|比例|版式|排版|布局|位置关系)`,
      'iu',
    ).test(requirement);
  });
}

export function buildArtworkComponentPlan(input: {
  request: ArtworkPreparationRequest;
  resolution: ArtworkResolutionAssessment;
  route: ArtworkRouteDecision;
}): ArtworkComponentPlan {
  const { request, route } = input;
  if (request.primaryImageRole === 'reference') {
    const labels = [request.primaryImageLabel, ...request.referenceImages.map(image => image.label)];
    return {
      graphic: { label: '生成的文字图案', method: 'model-rebuild-graphic' },
      texts: [{ id: 'text-1', value: request.exactText, method: 'model-styled-text', referenceLabels: labels }],
      references: labels.map(label => ({ label, method: 'reference-only', roles: ['style', 'layout'] })),
      sequence: [{ kind: 'text', id: 'text-1' }],
      summary: [`准确文字：${request.exactText}`, ...labels.map(label => `${label}：仅作样式参考，不复制原文字、人物或衣服`), '按准确文字与参考样式生成完整候选，再人工确认'],
    };
  }
  const intent = artworkIntent(request);
  const composition = describeArtworkComposition({
    instruction: request.instruction,
    exactText: request.exactText,
    layoutNote: request.layoutNote,
    primaryImageLabel: request.primaryImageLabel,
    referenceImageLabels: request.referenceImages.map((reference) => reference.label),
  });
  const textSegments = composition.textSegments;
  const referenceLabels = request.referenceImages.map((reference) => reference.label);
  const usesModelStyledText = route.route === 'hybrid'
    && textSegments.length > 0
    && (intent.hasStyleReference || intent.specialTypography);
  const textMethod: ArtworkComponentPlan['texts'][number]['method'] = usesModelStyledText
    ? 'model-styled-text'
    : intent.geometricTextTransform
      ? 'deterministic-transform'
      : 'deterministic-text';
  const texts = textSegments.map((value, index) => ({
    id: `text-${index + 1}`,
    value,
    method: textMethod,
    referenceLabels: usesModelStyledText ? referenceLabels : [],
  }));
  let nextTextIndex = 0;
  const sequence: ArtworkComponentPlan['sequence'] = composition.sequence.map((component) => component.kind === 'graphic'
    ? component
    : { kind: 'text', id: texts[nextTextIndex++]?.id ?? '' });
  if (sequence.some((component) => component.kind === 'text' && !component.id)) {
    throw new Error(`无法把文字组件映射到成品顺序：${composition.description}`);
  }
  const graphicMethod = route.route === 'model'
    ? 'model-rebuild-graphic'
    : 'fidelity-graphic';
  const references = request.referenceImages.map((reference) => ({
    label: reference.label,
    method: 'reference-only' as const,
    roles: [
      ...(/字体|字形|风格|笔触|书法|参考|按照/iu.test(`${request.instruction}\n${request.layoutNote}`)
        ? ['style' as const]
        : []),
      ...(/排版|布局|位置|参考|按照/iu.test(`${request.instruction}\n${request.layoutNote}`)
        ? ['layout' as const]
        : []),
    ],
  }));
  const summary = route.route === 'model'
    ? [
        `${request.primaryImageLabel}：作为必须进入成品的主体，参与完整模型生成`,
        ...texts.map((text) => `文字“${text.value}”：作为准确内容进入完整模型生成`),
        ...references.map((reference) => `${reference.label}：只参考${reference.roles.includes('style') ? '字体/风格' : ''}${reference.roles.includes('style') && reference.roles.includes('layout') ? '与' : ''}${reference.roles.includes('layout') ? '排版' : ''}，不复制人物、衣服或背景`),
        '主要素材、参考图和完整要求一次进入模型；输出完整候选后必须人工确认',
      ]
    : [
        `${request.primaryImageLabel}：${graphicMethod === 'fidelity-graphic' ? '进入成品并保真处理' : '低清主体单独重建'}`,
        ...texts.map((text) => `文字“${text.value}”：${text.method === 'model-styled-text' ? `参考${text.referenceLabels.join('、')}生成特殊字形` : text.method === 'deterministic-transform' ? '程序生成准确文字并执行几何变形' : '程序生成准确文字'}`),
        ...references.map((reference) => `${reference.label}：仅作${reference.roles.includes('style') ? '字体/风格' : ''}${reference.roles.includes('style') && reference.roles.includes('layout') ? '与' : ''}${reference.roles.includes('layout') ? '排版' : ''}参考，不进入成品`),
        '各组件分别处理后，由程序分层合成',
      ];
  return { graphic: { label: request.primaryImageLabel, method: graphicMethod }, texts, references, sequence, summary };
}

export function decideArtworkProcessingRoute(input: {
  request: ArtworkPreparationRequest;
  resolution: ArtworkResolutionAssessment;
}): ArtworkRouteDecision {
  const requestedRoute = input.request.processingRoute;
  if (requestedRoute !== 'auto') {
    return {
      route: requestedRoute,
      label: ROUTE_LABELS[requestedRoute],
      reasons: [`人工指定“${ROUTE_LABELS[requestedRoute]}”路线`],
      userOverride: true,
    };
  }

  const intent = artworkIntent(input.request);

  if (intent.wholeCompositionReference) {
    return {
      route: 'model',
      label: ROUTE_LABELS.model,
      reasons: [
        '参考图同时决定图形与文字的整体版式、比例或视觉层级',
        '拆成独立组件会丢失完整构图关系，应把主要素材、参考图和完整要求一次交给模型',
      ],
      userOverride: false,
    };
  }

  if ((intent.hasStyleReference || intent.specialTypography)
    && input.request.exactText.length > 0) {
    return {
      route: 'hybrid',
      label: ROUTE_LABELS.hybrid,
      reasons: [
        '成品同时包含需保留的主体图形和需要视觉生成的特殊文字',
        '主体、文字和参考图分别处理，最后由程序分层合成',
      ],
      userOverride: false,
    };
  }

  if (input.resolution.requiredScale > 4 || Math.min(
    input.resolution.subjectWidth,
    input.resolution.subjectHeight,
  ) < 128) {
    return {
      route: 'model',
      label: ROUTE_LABELS.model,
      reasons: [
        `主体仅 ${input.resolution.subjectWidth}×${input.resolution.subjectHeight}px，达到目标需放大 ${input.resolution.requiredScale}×`,
        '原像素不足以可靠恢复特殊字形或细节，生成候选后必须人工确认',
      ],
      userOverride: false,
    };
  }
  if (intent.selectiveComposition || input.request.referenceImages.length > 0) {
    return {
      route: 'model',
      label: ROUTE_LABELS.model,
      reasons: [intent.selectiveComposition
        ? '要求从素材中截取指定局部并重新组成完整图案'
        : '要求组合多张素材，无法用单图抠图和普通文字层准确完成'],
      userOverride: false,
    };
  }
  if (intent.specialTypography) {
    return {
      route: 'hybrid',
      label: ROUTE_LABELS.hybrid,
      reasons: [
        '包含普通字体层无法表达的特殊字形',
        '先保留主要图形，再由模型完成需要视觉生成的部分',
      ],
      userOverride: false,
    };
  }
  return {
    route: 'fidelity',
    label: ROUTE_LABELS.fidelity,
    reasons: ['要求仅涉及去背景、保真增强、换色或普通准确文字，可确定性完成'],
    userOverride: false,
  };
}

export function recommendedEnhancement(input: {
  sourceWidth: number;
  sourceHeight: number;
  resolution: ArtworkResolutionAssessment;
  quality: ArtworkQualityEvaluation;
  preserveGeometry: boolean;
}) : {
  level: ArtworkQualityLevel;
  enhancement: 'none' | 'standard' | 'professional';
  decisionRule: string;
} {
  const shortEdge = Math.min(input.sourceWidth, input.sourceHeight);
  const longEdge = Math.max(input.sourceWidth, input.sourceHeight);
  const clarity = clarityFromStandardBlur(input.quality.blur);
  const blurLevel: ArtworkQualityLevel = clarity < 45
    ? 'severe'
    : clarity < 70 ? 'low' : 'usable';
  const visualQualityLevel: ArtworkQualityLevel = input.quality.vqscore < 45
    ? 'severe'
    : input.quality.vqscore < 65 ? 'low' : 'usable';
  const noiseLevel: ArtworkQualityLevel = input.quality.noise === null
    ? 'usable'
    : input.quality.noise < 45 ? 'severe' : input.quality.noise < 70 ? 'low' : 'usable';
  const compressionLevel: ArtworkQualityLevel = input.quality.compressionArtifacts === null
    ? 'usable'
    : input.quality.compressionArtifacts > 45
      ? 'severe'
      : input.quality.compressionArtifacts > 25 ? 'low' : 'usable';
  const level = worstQualityLevel([
    input.resolution.level,
    blurLevel,
    visualQualityLevel,
    noiseLevel,
    compressionLevel,
  ]);
  if (level === 'usable') {
    return {
      level,
      enhancement: 'none',
      decisionRule: `主体 ${input.resolution.subjectWidth}×${input.resolution.subjectHeight}px，目标放大 ${input.resolution.requiredScale}×；清晰度和画质均达标，不增强`,
    };
  }
  const professionalSizeSupported = shortEdge >= 256 && longEdge <= 2048;
  if (input.preserveGeometry) {
    if (!professionalSizeSupported) {
      throw new Error(`Logo 需保真增强，但专业版要求原图短边≥256px且长边≤2048px；当前 ${input.sourceWidth}×${input.sourceHeight}px`);
    }
    return {
      level,
      enhancement: 'professional',
      decisionRule: `品牌图形需保真；主体 ${input.resolution.subjectWidth}×${input.resolution.subjectHeight}px，目标放大 ${input.resolution.requiredScale}×，画质等级 ${level}，使用 Professional fidelity_first 2×`,
    };
  }
  if (level === 'severe' && professionalSizeSupported) {
    return {
      level,
      enhancement: 'professional',
      decisionRule: `画质等级 severe；主体目标放大 ${input.resolution.requiredScale}×，使用 Professional fidelity_first 2× 生成待人工复核候选`,
    };
  }
  return {
    level,
    enhancement: 'standard',
    decisionRule: `画质等级 ${level}；主体目标放大 ${input.resolution.requiredScale}×，使用 Standard 2×`,
  };
}

export function artworkDraftFromPreparedGraphic(input: {
  graphicDataUrl: string;
  recolorMaskUrl?: string | null;
  graphicWidth: number;
  graphicHeight: number;
  request: ArtworkPreparationRequest;
  quality: ArtworkQualityEvaluation | null;
  enhancement: 'none' | 'standard' | 'professional';
  backgroundRemoval: 'none' | 'edge-connected' | 'product' | 'general';
  sourceKind: ArtworkSourceKind;
  resolution: ArtworkResolutionAssessment;
  route: ArtworkRouteDecision;
  componentPlan: ArtworkComponentPlan;
}) {
  return createStructuredArtworkDraft({
    graphicSourceUrl: input.graphicDataUrl,
    recolorMaskUrl: input.recolorMaskUrl,
    graphicWidth: input.graphicWidth,
    graphicHeight: input.graphicHeight,
    exactText: input.request.exactText,
    instruction: input.request.instruction,
    layoutNote: input.request.layoutNote,
    qualityScore: input.quality?.vqscore ?? null,
    blurScore: input.quality?.blur ?? null,
    enhancement: input.enhancement,
    backgroundRemoval: input.backgroundRemoval,
    sourceKind: input.sourceKind,
    resolution: input.resolution,
    processingRoute: input.route.route,
    routeReasons: input.route.reasons,
    routeOverride: input.route.userOverride,
    generationModel: null,
    componentSummary: input.componentPlan.summary,
  });
}
