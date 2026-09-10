const networkReasons: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: '连接服务超时', ETIMEDOUT: '连接服务超时',
  UND_ERR_HEADERS_TIMEOUT: '等待服务响应超时', UND_ERR_BODY_TIMEOUT: '读取服务结果超时',
  ECONNRESET: '连接被中途断开', EPIPE: '连接被中途断开', UND_ERR_SOCKET: '连接被中途断开',
  ECONNREFUSED: '服务拒绝连接', ENOTFOUND: '服务域名解析失败', EAI_AGAIN: '服务域名解析暂时失败',
  ENETUNREACH: '无法连接服务所在网络', EHOSTUNREACH: '无法连接服务主机',
  CERT_HAS_EXPIRED: '服务安全证书已过期', UNABLE_TO_VERIFY_LEAF_SIGNATURE: '服务安全证书校验失败',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务安全证书校验失败', ERR_TLS_CERT_ALTNAME_INVALID: '服务安全证书与域名不匹配',
};

/** Inspect causes without returning raw URLs, signed query strings or credentials. */
export function artworkNetworkFailure(error: unknown, fallbackStage = '图案处理') {
  const pending: unknown[] = [error], seen = new Set<object>(), codes = new Set<string>();
  let generic = false, timeout = false, stage = fallbackStage;
  for (let count = 0; pending.length && count < 16; count++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof ArtworkNetworkError) stage = value.stage;
    const item = value as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof item.code === 'string' && Object.hasOwn(networkReasons, item.code)) codes.add(item.code);
    if (item.name === 'TimeoutError') timeout = true;
    if (typeof item.message === 'string' && /^(?:fetch failed|failed to fetch|load failed|terminated|networkerror when attempting to fetch resource\.?)$/iu.test(item.message.trim())) generic = true;
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
  }
  if (!codes.size && !generic && !timeout) return null;
  const reasons = [...new Set([...codes].map(code => networkReasons[code]))];
  const reason = reasons.length ? reasons.join('；') : timeout ? '等待服务响应超时' : '网络请求失败，未取得更具体的连接原因';
  return { stage, codes: [...codes], message: `${stage}未完成：${reason}。` };
}

class ArtworkNetworkError extends Error {
  constructor(readonly stage: string, message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ArtworkNetworkError';
  }
}

/** Never retry here: a failed response does not prove a paid request was rejected. */
export async function withArtworkNetworkContext<T>(stage: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    const failure = artworkNetworkFailure(error, stage);
    if (!failure) throw error;
    throw new ArtworkNetworkError(failure.stage, failure.message, error);
  }
}
