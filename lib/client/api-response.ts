/** Preserve the server's reason and recovery metadata across JSON and file endpoints. */
export class ApiResponseError extends Error {
  readonly authorizeUrl: string | null;
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.authorizeUrl = body && typeof body === 'object' && 'authorizeUrl' in body && typeof body.authorizeUrl === 'string' ? body.authorizeUrl : null;
  }
}

export function apiErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('error' in body)) return null;
  return typeof body.error === 'string' && body.error.trim() ? body.error.trim() : null;
}

export function apiResponseError(response: Response, body: unknown, context = '请求失败') {
  const status = response.status;
  const reason = status === 401 ? '登录已过期或尚未登录'
    : status === 403 ? '没有访问权限' : status === 404 ? '请求的内容不存在'
      : status === 409 ? '内容或状态已变化' : status === 429 ? '请求过于频繁'
        : status === 504 ? '服务器响应超时' : '服务器返回异常';
  return new ApiResponseError(apiErrorMessage(body) ?? `${context}：${reason}（HTTP ${status}）`, status, body);
}

/** Parsing alone keeps typed failure receipts available to streaming/paid-work callers. */
export async function readApiPayload(response: Response, context = '请求失败') {
  try { return await response.json(); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof TypeError) throw new ApiResponseError(`${context}：读取服务器响应中断（HTTP ${response.status}）；${error.message}`, response.status);
    if (!response.ok) throw apiResponseError(response, null, context);
    throw new ApiResponseError(`${context}：服务器响应不完整或格式不正确（HTTP ${response.status}）`, response.status);
  }
}

export async function readApiJson(response: Response, context = '请求失败') {
  const body = await readApiPayload(response, context);
  if (!response.ok) throw apiResponseError(response, body, context);
  return body;
}

export async function assertApiResponse(response: Response, context = '请求失败') {
  if (!response.ok) throw apiResponseError(response, await readApiPayload(response, context), context);
}

export async function readApiBlob(response: Response, context = '读取图片失败') {
  await assertApiResponse(response, context);
  try { return await response.blob(); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`${context}：下载中断；${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** No retries here: a lost mutation response does not establish whether it was saved. */
export async function fetchApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try { return await fetch(input, init); }
  catch (error) {
    if (init?.signal?.aborted) throw init.signal.reason;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`未收到服务器响应：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Image elements hide HTTP errors. Diagnose our own endpoints only after a failure. */
export async function imageFailureReason(url: string, signal?: AbortSignal): Promise<string> {
  if (!url.startsWith('/api/')) return '图片加载失败，浏览器未提供具体原因；请检查图片链接和访问权限后重试。';
  try {
    const response = await fetchApi(url, { cache: 'no-store', signal });
    await assertApiResponse(response, '图片读取失败');
    await response.body?.cancel();
    return '图片接口已返回，但浏览器无法显示图片；请重新读取，若仍失败需检查图片格式或访问限制。';
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return error instanceof Error ? error.message : String(error);
  }
}
