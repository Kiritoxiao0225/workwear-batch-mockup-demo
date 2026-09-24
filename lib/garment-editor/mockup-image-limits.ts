export const MOCKUP_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MOCKUP_REMOTE_TIMEOUT_MS = 20_000;

export class MockupImageBoundaryError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'MockupImageBoundaryError';
  }
}

export interface NormalizedBase64Image {
  base64Data: string;
  dataUrl: string;
  byteLength: number;
}

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function base64ByteLength(base64Data: string) {
  const padding = base64Data.endsWith('==')
    ? 2
    : base64Data.endsWith('=')
      ? 1
      : 0;
  return Math.floor((base64Data.length * 3) / 4) - padding;
}

export function normalizeMockupBase64Image(value: unknown): NormalizedBase64Image {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MockupImageBoundaryError('base64Image 不能为空，收到空值', 400);
  }

  const trimmed = value.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]*)$/.exec(trimmed);
  if (trimmed.startsWith('data:') && !dataUrlMatch) {
    throw new MockupImageBoundaryError('base64Image 必须是合法的 base64 data URL', 400);
  }

  const mimeType = dataUrlMatch?.[1]?.toLowerCase() ?? 'image/png';
  if (!mimeType.startsWith('image/')) {
    throw new MockupImageBoundaryError(`base64Image 必须是图片，收到 ${mimeType}`, 400);
  }

  const base64Data = (dataUrlMatch?.[2] ?? trimmed).replace(/\s/g, '');
  const hasInvalidPadding = base64Data.includes('=') && base64Data.length % 4 !== 0;
  if (
    !base64Data ||
    base64Data.length % 4 === 1 ||
    hasInvalidPadding ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)
  ) {
    throw new MockupImageBoundaryError('base64Image 编码不合法', 400);
  }

  const byteLength = base64ByteLength(base64Data);
  if (byteLength > MOCKUP_IMAGE_MAX_BYTES) {
    throw new MockupImageBoundaryError(
      `base64Image 不能超过 10MB，当前 ${byteLength} 字节`,
      413
    );
  }

  return {
    base64Data,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
    byteLength,
  };
}

export async function fetchMockupRemote(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: {
    timeoutMs?: number;
    fetchImplementation?: FetchImplementation;
  } = {}
) {
  const timeoutMs = options.timeoutMs ?? MOCKUP_REMOTE_TIMEOUT_MS;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'));
  }, timeoutMs);
  const requestSignal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetchImplementation(input, { ...init, signal: requestSignal });
  } catch (err) {
    if (timeoutController.signal.aborted) {
      throw new MockupImageBoundaryError(
        `远程图片请求超过 ${Math.round(timeoutMs / 1000)} 秒`,
        504
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new MockupImageBoundaryError(`远程图片请求失败：${detail}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export function toMockupImageBoundaryError(err: unknown) {
  if (err instanceof MockupImageBoundaryError) return err;
  if (
    err instanceof DOMException &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return new MockupImageBoundaryError('远程图片请求超过 20 秒', 504);
  }
  return null;
}

export async function readMockupRemoteImage(
  response: Response,
  maxBytes = MOCKUP_IMAGE_MAX_BYTES
) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new MockupImageBoundaryError(
      `远程图片不能超过 10MB，Content-Length 为 ${contentLength} 字节`,
      502
    );
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new MockupImageBoundaryError(
        `远程图片不能超过 10MB，当前 ${bytes.byteLength} 字节`,
        502
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new MockupImageBoundaryError(
          `远程图片不能超过 10MB，已读取 ${byteLength} 字节`,
          502
        );
      }
      chunks.push(chunk);
    }
  } catch (err) {
    const boundaryError = toMockupImageBoundaryError(err);
    if (boundaryError) throw boundaryError;
    throw err;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
