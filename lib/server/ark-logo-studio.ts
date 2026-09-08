import {
  buildLogoAnalysisPrompt,
  parseLogoStudioAnalysis,
  type LogoStudioAnalysis,
  type LogoStudioRequest,
  type LogoStudioResponse,
} from '@/lib/logo-studio';
import { removeWhiteLogoBackground } from '@/lib/server/logo-composition';
import { createLogoTextGuideDataUrl } from '@/lib/server/logo-text-guide';

const ARK_CHAT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const ARK_IMAGE_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const DEFAULT_ANALYSIS_MODEL = 'doubao-seed-2-0-lite-260215';
const DEFAULT_GENERATION_MODEL = 'doubao-seedream-4-0-250828';
const DEFAULT_GENERATION_SIZE = '1K';
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

async function arkFetch(label: string, input: string, init: RequestInit, timeoutMs: number) {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`${label}超过 ${Math.round(timeoutMs / 1000)} 秒未返回，请重试`);
    }
    throw error;
  }
}

function requireArkApiKey() {
  const key = process.env.ARK_RUNTIME_API_KEY?.trim() || process.env.ARK_API_KEY?.trim();
  if (!key) throw new Error('ARK_RUNTIME_API_KEY or ARK_API_KEY is not configured');
  return key;
}

export function formatArkErrorMessage(
  label: string,
  status: number,
  body: unknown,
) {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : {};
  const message = typeof error.message === 'string'
    ? error.message
    : typeof record.message === 'string'
      ? record.message
      : 'unknown error';
  const code = typeof error.code === 'string' ? error.code : '';
  if (status === 429 && (code === 'SetLimitExceeded' || message.includes('Safe Experience Mode'))) {
    return '火山方舟“安心体验”免费推理额度已用尽，Seedream 服务已暂停。请到火山方舟「开通管理」关闭安心体验后重试；关闭后调用将按量计费，且安心体验无法再次开启。';
  }
  if (status === 403) {
    return '当前服务端 API Key 没有请求的 Seedream 模型权限。请在火山方舟「API Key 管理」中为该 Key 增加对应模型后重试。';
  }
  return `${label} 调用失败：HTTP ${status} · ${message}`;
}

async function readJson(response: Response, label: string) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} 返回了无效 JSON：HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(formatArkErrorMessage(label, response.status, body));
  }
  return body;
}

function analysisContent(body: unknown) {
  if (!body || typeof body !== 'object') throw new Error('视觉模型响应必须是对象');
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    throw new Error('视觉模型响应缺少 choices[0]');
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') throw new Error('视觉模型响应缺少 message');
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('视觉模型响应没有文字内容');
  }
  return content;
}

async function analyzeLogoRequest(
  request: LogoStudioRequest,
  apiKey: string,
  model: string,
): Promise<LogoStudioAnalysis> {
  const response = await arkFetch('Logo 图片分析模型', ARK_CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildLogoAnalysisPrompt(request) },
          ...request.images.flatMap((image, index) => [
            { type: 'text', text: `以下是图${index + 1}：${image.fileName}` },
            { type: 'image_url', image_url: { url: image.dataUrl } },
          ]),
        ],
      }],
      max_tokens: 2_000,
      temperature: 0.1,
      stream: false,
    }),
  }, 90_000);
  return parseLogoStudioAnalysis(analysisContent(await readJson(response, 'Logo 图片分析模型')));
}

export function buildCompleteLogoGenerationPrompt(
  request: LogoStudioRequest,
  analysis: LogoStudioAnalysis,
) {
  const ordinalNames = ['第一', '第二', '第三'];
  const generationImages = generationInputs(request);
  const guideOrdinal = ordinalNames[generationImages.length];
  const usesAllReferences = generationImages.length === request.images.length;
  const referenceList = generationImages
    .map(({ image, sourceIndex }, index) => usesAllReferences
      ? `- 图${index + 1}：${image.fileName}`
      : `- 生图输入图${index + 1}（分析阶段图${sourceIndex + 1}）：${image.fileName}`)
    .join('\n');
  const referenceIntroduction = usesAllReferences
    ? `前 ${generationImages.length} 张输入图是客户上传的参考图，顺序与用户原话中的编号完全一致：`
    : `本次只把 ${generationImages.length} 张真正需要复用像素或风格的素材交给生图模型；其余参考图只在分析阶段用于判断排版，不得复刻其中的人物、衣服、场景或背景：`;
  const targetTextRule = analysis.output.targetText
    ? `最终新文字只能是“${analysis.output.targetText}”，必须逐字准确，不得出现原图旧文字，不得增字、漏字、错字或添加序号。`
    : '用户没有要求新增文字，不得自行添加任何文字。';
  return `你正在制作一张独立的二维平面 Logo/印花图案素材。请一次生成一个完整 Logo 图案，不要拆成图形层和文字层，也不要分别生成后拼接。输入中的衣服款式和制作位置只说明图案未来放在哪里，不属于图案内容。\n\n${referenceIntroduction}\n${referenceList}\n不得默认把图1当作 Logo 来源；Logo 图形、字体视觉和颜色分别取自哪张图，只能按用户原话和下方分析结果决定。\n${guideOrdinal}张输入图是程序生成的目标文字黑白骨架：它只负责锁定每个汉字的字形结构、顺序和数量，绝不是字体风格参考。\n\n用户原始要求：\n${request.instruction}\n\n视觉模型已经确认：\n- 必须保留且不得改变的内容：${analysis.source.keep.join('；') || '用户指定保留的原图内容'}\n- 必须删除或替换的内容：${analysis.source.remove.join('；') || '无'}\n- 唯一目标文字：${analysis.output.targetText || '无'}\n- 字体与颜色参考：${analysis.source.colorReference || '按用户原话'}\n- 完整 Logo 排版：${analysis.output.layout}\n\n必须同时遵守：\n1. ${targetTextRule}\n2. 用户指定作为 Logo 来源的图中，“${analysis.source.keep.join('；') || '原 Logo 图形'}”是品牌识别主体。必须沿用同一个图形，保持全部线条、折角、曲线、连接关系、内部白色负形、比例、方向和配色；不得重新设计、替换或改变任何结构。\n3. 其他客户参考图只能提供用户点名的字体视觉或颜色，不得把其中的其他图形、旧文字、边框、界面和无关内容带入结果。\n4. 严格复制${guideOrdinal}张骨架图中的文字结构与顺序；字体视觉只参考“${analysis.source.colorReference || '用户指定参考图中的原文字'}”的笔画粗细、收笔、转角、倾斜和手写或书法气质。新文字不能使用普通黑体、默认无衬线体或骨架图的字体风格。\n5. 按“${analysis.output.layout}”一次完成图形和文字的相对大小、间距与居中关系。只输出一个完整版本，纯白背景并保留安全留白。画面中只能出现最终图案本身；严禁输出人物、模特、衣服、衣领、袖子、布料、产品展示、场景、门店、手机界面、二维码、边框、标签、说明、序号或版本号。`;
}

function generationInputs(request: LogoStudioRequest) {
  const indexes = request.generationImageIndexes
    ?? request.images.map((_, index) => index);
  if (indexes.length === 0 || new Set(indexes).size !== indexes.length) {
    throw new Error(`generationImageIndexes 必须包含不重复的图片序号，实际 ${indexes.join(',')}`);
  }
  return indexes.map((sourceIndex) => {
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= request.images.length) {
      throw new Error(`generationImageIndexes 包含越界序号：${sourceIndex}`);
    }
    return { image: request.images[sourceIndex], sourceIndex };
  });
}

function generatedImageUrl(body: unknown) {
  if (!body || typeof body !== 'object') throw new Error('图片生成模型响应必须是对象');
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== 'object') {
    throw new Error('图片生成模型响应缺少 data[0]');
  }
  const url = (data[0] as Record<string, unknown>).url;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('图片生成模型没有返回 HTTPS 下载地址');
  }
  return url;
}

async function generateImageBuffer(
  prompt: string,
  images: string[],
  apiKey: string,
  model: string,
  label: string,
) {
  const response = await arkFetch(label, ARK_IMAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      image: images,
      size: DEFAULT_GENERATION_SIZE,
      stream: false,
      response_format: 'url',
      ...(model.startsWith('doubao-seedream-5-0-') ? { output_format: 'png' } : {}),
      watermark: false,
    }),
  }, 120_000);
  const body = await readJson(response, label);
  const downloadResponse = await arkFetch('生成图片下载', generatedImageUrl(body), {}, 60_000);
  if (!downloadResponse.ok) {
    throw new Error(`生成图片下载失败：HTTP ${downloadResponse.status}`);
  }
  const contentType = downloadResponse.headers.get('content-type')?.split(';')[0]?.trim() || '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
    throw new Error(`生成图片类型不支持：${contentType || '未返回'}`);
  }
  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(`生成图片大小必须在 1B 到 20MB，实际 ${bytes.length}B`);
  }
  return bytes;
}

async function generateCompleteLogo(
  request: LogoStudioRequest,
  analysis: LogoStudioAnalysis,
  resolvedPrompt: string,
  apiKey: string,
  model: string,
) {
  const images = generationInputs(request).map(({ image }) => image.dataUrl);
  const targetText = request.targetText?.trim() || analysis.output.targetText;
  if (targetText) {
    images.push(await createLogoTextGuideDataUrl(targetText));
  }
  return generateImageBuffer(
    resolvedPrompt,
    images,
    apiKey,
    model,
    '完整 Logo 图片生成模型',
  );
}

export async function generateStyledTextArtwork(input: {
  text: string;
  styleInstruction: string;
  styleReference?: LogoStudioRequest['images'][number] | null;
}) {
  const text = input.text.trim();
  if (!text) throw new Error('特殊文字生成缺少准确文字');
  if (text.length > 40) throw new Error(`单个特殊文字组件最多 40 个字符，实际 ${text.length} 个`);
  const apiKey = requireArkApiKey();
  const model = process.env.ARK_IMAGE_MODEL?.trim() || DEFAULT_GENERATION_MODEL;
  const guide = await createLogoTextGuideDataUrl(text);
  const referenceRule = input.styleReference
    ? `第一张图只用于参考字体笔触、粗细、倾斜、收笔和视觉气质；不得复制其中的人物、衣服、Logo、背景或其他文字。第二张图是准确文字骨架。`
    : '输入图是准确文字骨架；请在不改变字形结构和字数的前提下生成清晰的艺术字。';
  const prompt = `你只制作一个独立的二维特殊文字素材，不制作完整 Logo，也不生成衣服或场景。\n${referenceRule}\n唯一允许出现的文字是“${text}”，必须逐字准确，不得增字、漏字、错字、拆字或加入英文、序号和装饰性小字。\n风格要求：${input.styleInstruction || '保持清晰、适合工作服印花的字形'}。\n文字居中、完整、不裁切，纯白背景，四周保留安全留白。除目标文字本身外不得出现任何图形、边框、标志、照片或说明。`;
  const generated = await generateImageBuffer(
    prompt,
    [
      ...(input.styleReference ? [input.styleReference.dataUrl] : []),
      guide,
    ],
    apiKey,
    model,
    `特殊文字“${text}”生成模型`,
  );
  const transparent = await removeWhiteLogoBackground(generated);
  return {
    dataUrl: `data:image/png;base64,${transparent.toString('base64')}`,
    model,
  };
}

export async function runLogoStudio(request: LogoStudioRequest): Promise<LogoStudioResponse> {
  const startedAt = Date.now();
  const apiKey = requireArkApiKey();
  const analysisModel = process.env.VISION_MODEL_EP?.trim() || DEFAULT_ANALYSIS_MODEL;
  const generationModel = process.env.ARK_IMAGE_MODEL?.trim() || DEFAULT_GENERATION_MODEL;
  const analysis = await analyzeLogoRequest(request, apiKey, analysisModel);
  const resolvedPrompt = request.generationPrompt?.trim()
    || buildCompleteLogoGenerationPrompt(request, analysis);

  if (!analysis.canGenerate || analysis.ambiguities.length > 0) {
    return {
      status: 'needs_confirmation',
      analysis,
      generatedImage: null,
      models: { analysis: analysisModel, generation: null },
      resolvedPrompt,
      promptVersion: request.generationPromptVersion ?? null,
      promptHash: request.generationPromptHash ?? null,
      imageMapping: request.imageMapping ?? [],
      durationMs: Date.now() - startedAt,
    };
  }

  const generatedLogo = await generateCompleteLogo(
    request,
    analysis,
    resolvedPrompt,
    apiKey,
    generationModel,
  );
  const completeLogo = await removeWhiteLogoBackground(generatedLogo);

  return {
    status: 'generated',
    analysis,
    generatedImage: {
      dataUrl: `data:image/png;base64,${completeLogo.toString('base64')}`,
      contentType: 'image/png',
      model: generationModel,
    },
    models: { analysis: analysisModel, generation: generationModel },
    resolvedPrompt,
    promptVersion: request.generationPromptVersion ?? null,
    promptHash: request.generationPromptHash ?? null,
    imageMapping: request.imageMapping ?? [],
    durationMs: Date.now() - startedAt,
  };
}
