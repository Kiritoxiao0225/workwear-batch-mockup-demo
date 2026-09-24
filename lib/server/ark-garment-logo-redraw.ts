import sharp from 'sharp';

import { requireArkApiKey } from '../garment-editor/ark-runtime';
import {
  buildLogoRedrawAnalysisPrompt,
  buildLogoRedrawGenerationPrompt,
  parseLogoRedrawAnalysis,
  type LogoRedrawAnalysis,
  type LogoRedrawAnalyzeRequest,
  type LogoRedrawGenerateRequest,
} from '../garment-editor/mockup-logo-redraw';
import {
  MOCKUP_IMAGE_MAX_BYTES,
  readMockupRemoteImage,
} from '../garment-editor/mockup-image-limits';

const ARK_CHAT_ENDPOINT =
  'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const ARK_IMAGE_ENDPOINT =
  'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const DEFAULT_ANALYSIS_MODEL = 'doubao-seed-2-0-lite-260215';
const DEFAULT_GENERATION_MODEL = 'doubao-seedream-4-0-250828';
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 60_000;
const GENERATION_TIMEOUT_MS = 165_000;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const TEXT_GUIDE_WIDTH = 1536;
const TEXT_GUIDE_HEIGHT = 768;

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

interface LogoRedrawServerOptions {
  env?: Record<string, string | undefined>;
  fetchImplementation?: FetchImplementation;
  signal?: AbortSignal;
}

export interface LogoRedrawServiceErrorShape {
  message: string;
  status: number;
  code:
    | 'LOGO_REDRAW_MODEL_PERMISSION'
    | 'LOGO_REDRAW_RATE_LIMITED'
    | 'LOGO_REDRAW_TIMEOUT'
    | 'LOGO_REDRAW_UPSTREAM';
}

export class LogoRedrawServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: LogoRedrawServiceErrorShape['code']
  ) {
    super(message);
    this.name = 'LogoRedrawServiceError';
  }
}

function upstreamErrorRecord(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  return record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? (record.error as Record<string, unknown>)
    : record;
}

export function formatLogoRedrawArkError(
  label: string,
  status: number,
  body: unknown
): LogoRedrawServiceErrorShape {
  const upstreamError = upstreamErrorRecord(body);
  const upstreamCode =
    typeof upstreamError.code === 'string' ? upstreamError.code : '';
  const upstreamMessage =
    typeof upstreamError.message === 'string' ? upstreamError.message : '';

  if (status === 403) {
    return {
      message: `当前服务端 API Key 没有请求的 ${label} 模型权限，请检查火山方舟模型授权。`,
      status: 403,
      code: 'LOGO_REDRAW_MODEL_PERMISSION',
    };
  }
  if (
    status === 429 &&
    (upstreamCode === 'SetLimitExceeded' ||
      upstreamMessage.includes('Safe Experience Mode'))
  ) {
    return {
      message:
        '火山方舟安心体验额度已用尽，Logo 生成服务已暂停；关闭安心体验后会按量计费。',
      status: 429,
      code: 'LOGO_REDRAW_RATE_LIMITED',
    };
  }
  if (status === 429) {
    return {
      message: `${label}请求过多或额度不足，请稍后重试。`,
      status: 429,
      code: 'LOGO_REDRAW_RATE_LIMITED',
    };
  }
  return {
    message: `${label}暂时不可用（HTTP ${status}），请稍后重试。`,
    status: 502,
    code: 'LOGO_REDRAW_UPSTREAM',
  };
}

function timeoutSignal(timeoutMs: number, suppliedSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return suppliedSignal ? AbortSignal.any([suppliedSignal, timeout]) : timeout;
}

function timeoutError(label: string, timeoutMs: number) {
  return new LogoRedrawServiceError(
    `${label}超过 ${Math.round(timeoutMs / 1_000)} 秒，请重试。`,
    504,
    'LOGO_REDRAW_TIMEOUT'
  );
}

function isAbortError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

async function fetchJson(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImplementation: FetchImplementation
) {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      signal: timeoutSignal(timeoutMs, init.signal ?? undefined),
    });
  } catch (error) {
    if (isAbortError(error)) throw timeoutError(label, timeoutMs);
    throw new LogoRedrawServiceError(
      `${label}请求失败，请检查网络后重试。`,
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LogoRedrawServiceError(
      `${label}返回了无效数据。`,
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  if (!response.ok) {
    const formatted = formatLogoRedrawArkError(label, response.status, body);
    throw new LogoRedrawServiceError(
      formatted.message,
      formatted.status,
      formatted.code
    );
  }
  return body;
}

function analysisContent(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LogoRedrawServiceError(
      'Logo 理解模型响应格式不正确。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    throw new LogoRedrawServiceError(
      'Logo 理解模型响应缺少结果。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  const message = (choices[0] as Record<string, unknown>).message;
  const content =
    message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : null;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LogoRedrawServiceError(
      'Logo 理解模型没有返回文字结果。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  return content;
}

function imageUrl(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LogoRedrawServiceError(
      'Logo 生成模型响应格式不正确。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  const data = (body as Record<string, unknown>).data;
  const url =
    Array.isArray(data) && data[0] && typeof data[0] === 'object'
      ? (data[0] as Record<string, unknown>).url
      : null;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new LogoRedrawServiceError(
      'Logo 生成模型没有返回安全下载地址。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  return url;
}

function escapeSvgText(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function createTextGuideDataUrl(targetText: string) {
  const characters = Array.from(targetText.trim());
  if (characters.length === 0) {
    throw new LogoRedrawServiceError(
      '文字骨架的目标文字不能为空。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  const maximumWidth = TEXT_GUIDE_WIDTH - 240;
  const fontSize = Math.max(
    48,
    Math.min(310, Math.floor(maximumWidth / characters.length))
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_GUIDE_WIDTH}" height="${TEXT_GUIDE_HEIGHT}" viewBox="0 0 ${TEXT_GUIDE_WIDTH} ${TEXT_GUIDE_HEIGHT}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" fill="#000000" font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" font-weight="700">${escapeSvgText(targetText.trim())}</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function downloadGeneratedImage(
  url: string,
  fetchImplementation: FetchImplementation,
  suppliedSignal?: AbortSignal
) {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      signal: timeoutSignal(DOWNLOAD_TIMEOUT_MS, suppliedSignal),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw timeoutError('Logo 生成结果下载', DOWNLOAD_TIMEOUT_MS);
    }
    throw new LogoRedrawServiceError(
      'Logo 生成结果下载失败。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  if (!response.ok) {
    throw new LogoRedrawServiceError(
      `Logo 生成结果下载失败（HTTP ${response.status}）。`,
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!contentType || !['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
    throw new LogoRedrawServiceError(
      `Logo 生成结果格式不支持：${contentType || '未返回'}`,
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  const bytes = await readMockupRemoteImage(
    response,
    MAX_GENERATED_IMAGE_BYTES
  );
  if (bytes.byteLength === 0) {
    throw new LogoRedrawServiceError(
      'Logo 生成结果为空。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  return Buffer.from(bytes);
}

export async function understandMockupLogoRedraw(
  request: LogoRedrawAnalyzeRequest,
  options: LogoRedrawServerOptions = {}
) {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const apiKey = requireArkApiKey(env);
  const model =
    env.MOCKUP_LOGO_ANALYSIS_MODEL?.trim() ||
    env.VISION_MODEL_EP?.trim() ||
    DEFAULT_ANALYSIS_MODEL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: buildLogoRedrawAnalysisPrompt(request) },
  ];
  request.images.forEach((image, index) => {
    content.push({ type: 'text', text: `以下是图${index + 1}：${image.fileName}` });
    content.push({ type: 'image_url', image_url: { url: image.base64Image } });
  });
  const body = await fetchJson(
    'Logo 理解模型',
    ARK_CHAT_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 2_000,
        temperature: 0.1,
        stream: false,
      }),
      signal: options.signal,
    },
    ANALYSIS_TIMEOUT_MS,
    fetchImplementation
  );
  let analysis: LogoRedrawAnalysis;
  try {
    analysis = parseLogoRedrawAnalysis(analysisContent(body));
  } catch (error) {
    if (error instanceof LogoRedrawServiceError) throw error;
    throw new LogoRedrawServiceError(
      error instanceof Error ? error.message : 'Logo 理解结果无法解析。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  return {
    analysis,
    model,
    durationMs: Date.now() - startedAt,
  };
}

export async function generateMockupLogoRedraw(
  request: LogoRedrawGenerateRequest,
  options: LogoRedrawServerOptions = {}
) {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const apiKey = requireArkApiKey(env);
  const model =
    env.MOCKUP_LOGO_GENERATION_MODEL?.trim() ||
    env.ARK_IMAGE_MODEL?.trim() ||
    DEFAULT_GENERATION_MODEL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const inputImages = request.images.map((image) => image.base64Image);
  if (request.analysis.output.targetText) {
    inputImages.push(
      await createTextGuideDataUrl(request.analysis.output.targetText)
    );
  }

  const body = await fetchJson(
    'Logo 生成模型',
    ARK_IMAGE_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: buildLogoRedrawGenerationPrompt(request),
        ...(inputImages.length > 0 ? { image: inputImages } : {}),
        size: '1K',
        stream: false,
        response_format: 'url',
        ...(model.startsWith('doubao-seedream-5-0-')
          ? { output_format: 'png' }
          : {}),
        watermark: false,
      }),
      signal: options.signal,
    },
    GENERATION_TIMEOUT_MS,
    fetchImplementation
  );
  const downloaded = await downloadGeneratedImage(
    imageUrl(body),
    fetchImplementation,
    options.signal
  );
  let rawCandidatePng: Buffer;
  let rawCandidateWidth: number;
  let rawCandidateHeight: number;
  try {
    const normalized = await sharp(downloaded)
      .png()
      .toBuffer({ resolveWithObject: true });
    rawCandidatePng = normalized.data;
    rawCandidateWidth = normalized.info.width;
    rawCandidateHeight = normalized.info.height;
  } catch (error) {
    if (error instanceof LogoRedrawServiceError) throw error;
    throw new LogoRedrawServiceError(
      'Logo 生成模型返回了无法处理的图片，请重新生成。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  if (rawCandidatePng.byteLength > MOCKUP_IMAGE_MAX_BYTES) {
    throw new LogoRedrawServiceError(
      `Logo 原始候选超过 10MB 限制，当前 ${rawCandidatePng.byteLength} 字节，请重新生成。`,
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  if (!rawCandidateWidth || !rawCandidateHeight) {
    throw new LogoRedrawServiceError(
      'Logo 原始候选缺少有效尺寸。',
      502,
      'LOGO_REDRAW_UPSTREAM'
    );
  }
  return {
    image: {
      dataUrl: `data:image/png;base64,${rawCandidatePng.toString('base64')}`,
      contentType: 'image/png' as const,
      model,
      width: rawCandidateWidth,
      height: rawCandidateHeight,
    },
    durationMs: Date.now() - startedAt,
  };
}
