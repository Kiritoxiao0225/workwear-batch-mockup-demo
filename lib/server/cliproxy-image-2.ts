import sharp from 'sharp';
import { waitUpTo } from './long-request';

export const CLIPROXY_ARTWORK_MODEL = 'gpt-image-2';
export const CLIPROXY_ARTWORK_OPTIONS = {
  model: CLIPROXY_ARTWORK_MODEL,
  size: '2048x2048',
  quality: 'medium',
  background: 'auto',
  output_format: 'png',
  response_format: 'b64_json',
  n: 1,
} as const;

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
export class CliproxyImageConfigurationError extends Error {}

function configuration() {
  const apiKey = process.env.CLIPROXY_API_KEY?.trim();
  if (!apiKey) throw new CliproxyImageConfigurationError('CLIPROXY_API_KEY 尚未配置；未发起生图请求');
  let base: URL;
  try {
    base = new URL(process.env.CLIPROXY_API_BASE_URL?.trim() || '');
  } catch {
    throw new CliproxyImageConfigurationError('CLIPROXY_API_BASE_URL 必须是包含 /v1 的 HTTPS 地址');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/u, '') !== '/v1') {
    throw new CliproxyImageConfigurationError('CLIPROXY_API_BASE_URL 必须是包含 /v1 的 HTTPS 地址');
  }
  return { apiKey, base: base.toString().replace(/\/$/u, '') };
}

function inputImage(value: string, index: number) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) throw new Error(`image ${index + 1} 必须是 PNG、JPEG 或 WebP 的 base64 图片`);
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== match[2]) throw new Error(`image ${index + 1} 编码无效或超过 8MB`);
  return { bytes, mime: match[1], extension: match[1].split('/')[1] };
}

async function readResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Codex 生图响应超过 30MB');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Codex 生图返回空响应');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Codex 生图响应超过 30MB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Codex 生图返回无效 JSON；未自动重试，请先核对服务记录');
  }
}

/** Ordered multipart files preserve the primary/reference mapping in the displayed prompt. */
export async function generateCliproxyArtwork(prompt: string, images: string[], settings: { background?: 'auto' | 'transparent' } = {}) {
  const { apiKey, base } = configuration();
  if (!prompt.trim() || [...prompt].length > 32_000) throw new Error('instruction 不能为空或超过 32000 字符');
  if (images.length > 16) throw new Error('image 单次最多支持 16 张图片');
  let body: BodyInit;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const options = { ...CLIPROXY_ARTWORK_OPTIONS, ...settings };
  if (images.length) {
    const form = new FormData();
    for (const [name, value] of Object.entries(options)) form.set(name, String(value));
    form.set('prompt', prompt);
    images.forEach((value, index) => {
      const image = inputImage(value, index);
      form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `input-${index + 1}.${image.extension}`);
    });
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ ...options, prompt });
  }

  let result: unknown;
  try {
    const response = await fetch(`${base}/images/${images.length ? 'edits' : 'generations'}`, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(240_000),
    });
    if (!response.ok) {
      // Recognize a specific capability error without reflecting arbitrary upstream
      // error bodies, which can contain credentials or OAuth details.
      const failure = await readResponse(response).catch(() => null);
      const upstreamError = failure && typeof failure === 'object' && 'error' in failure ? failure.error : null;
      if (response.status === 400 && upstreamError && typeof upstreamError === 'object'
        && 'code' in upstreamError && upstreamError.code === 'invalid_value'
        && 'message' in upstreamError && typeof upstreamError.message === 'string'
        && /transparent background is not supported for this model/iu.test(upstreamError.message)) {
        throw new Error('Codex 生图 HTTP 400：当前模型调用路径不支持原生透明输出；未自动改为白底、抠图或重试');
      }
      const reason = response.status === 401 || response.status === 403 ? '请检查代理 API Key 和 Codex 授权'
        : response.status === 429 ? '额度或并发受限，请检查服务状态' : '请检查代理服务记录';
      throw new Error(`Codex 生图 HTTP ${response.status}：${reason}；未自动重试`);
    }
    result = await readResponse(response);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Codex 生图')) throw error;
    throw new Error('Codex 生图连接中断或超时，结果未确认；未自动重试，请先核对代理服务记录');
  }
  const data = result && typeof result === 'object' && 'data' in result ? result.data : null;
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0]?.b64_json !== 'string') throw new Error('Codex 生图未返回唯一的 base64 图片；未自动重试');
  const encoded: string = data[0].b64_json;
  if (!encoded.length || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('Codex 生图内容为空、无效或超过 20MB');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length > MAX_IMAGE_BYTES) throw new Error('Codex 生图 base64 编码无效或超过 20MB');
  const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 16_777_216 }).metadata().catch(() => null);
  if (metadata?.format !== 'png' || !metadata.width || !metadata.height) throw new Error('Codex 生图返回内容不是有效 PNG');
  return {
    bytes, model: CLIPROXY_ARTWORK_MODEL,
    generationMetadata: {
      requestedBackground: options.background,
      hasAlpha: Boolean(metadata.hasAlpha),
      ...Object.fromEntries(['background', 'output_format', 'size', 'quality', 'revised_prompt'].flatMap(key => {
        const value = data[0][key] ?? (result as Record<string, unknown>)[key];
        return typeof value === 'string' ? [[key, value]] : [];
      })),
    },
    generationNote: `Codex ${CLIPROXY_ARTWORK_MODEL}（CLIProxyAPI）：请求 2048×2048 / Medium；实际 PNG ${metadata.width}×${metadata.height}`,
  };
}

const mimeOf = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png';

/**
 * One gpt-image-2 image for 电商主图: the reference images in the order the prompt names them (a
 * mask, transparent where to redraw, applies to the first), at the size asked. One request; a
 * failure says whether trying again can help (`retry`), and the caller decides (listing-provider).
 */
export async function cliproxyListingImage(input: { prompt: string; images: Buffer[]; size: string; mask?: Buffer; timeoutMs?: number }) {
  const { apiKey, base } = configuration();
  const options = { model: CLIPROXY_ARTWORK_MODEL, size: input.size, quality: 'medium', background: 'opaque', output_format: 'png', response_format: 'b64_json', n: 1 };
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: BodyInit;
  if (input.images.length) {
    const form = new FormData();
    for (const [name, value] of Object.entries(options)) form.set(name, String(value));
    form.set('prompt', input.prompt);
    input.images.forEach((bytes, i) => form.append('image[]', new Blob([new Uint8Array(bytes)], { type: mimeOf(bytes) }), `ref-${i + 1}.${mimeOf(bytes).split('/')[1]}`));
    if (input.mask) form.append('mask', new Blob([new Uint8Array(input.mask)], { type: 'image/png' }), 'mask.png');
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ ...options, prompt: input.prompt });
  }
  const started = Date.now(), wait = input.timeoutMs ?? 300_000;
  let result: unknown;
  try {
    const response = await fetch(`${base}/images/${input.images.length ? 'edits' : 'generations'}`, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(wait), dispatcher: waitUpTo(wait),
    } as RequestInit);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const reason = response.status === 401 || response.status === 403 ? '转接授权失效' : response.status === 429 ? '转接限速，稍后重做' : '转接服务出错';
      // Rate limits and server faults pass; a refused request (other 4xx) comes back the same way.
      throw Object.assign(new Error(`出图没有成功（HTTP ${response.status}，${reason}）`), { retry: response.status === 408 || response.status === 429 || response.status >= 500, limited: response.status === 429 });
    }
    result = await readResponse(response);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('出图没有成功')) throw error;
    throw Object.assign(new Error('出图连接中断或超时'), { retry: true });
  }
  const data = result && typeof result === 'object' && 'data' in result ? result.data : null;
  const encoded = Array.isArray(data) && typeof data[0]?.b64_json === 'string' ? data[0].b64_json as string : '';
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw Object.assign(new Error('出图没有返回图片'), { retry: true });
  const bytes = Buffer.from(encoded, 'base64');
  const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 16_777_216 }).metadata().catch(() => null);
  if (!metadata?.width || !metadata.height) throw Object.assign(new Error('出图返回的不是有效图片'), { retry: true });
  return { bytes, durationMs: Date.now() - started };
}
