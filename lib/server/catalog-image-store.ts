import { createHmac } from 'node:crypto';

export function imageStoreConfig() {
  const endpoint = process.env.CATALOG_IMAGE_STORE_URL;
  const token = process.env.CATALOG_IMAGE_STORE_TOKEN;
  const signingKey = process.env.CATALOG_IMAGE_STORE_SIGNING_KEY;
  if (!endpoint || !token || token.length < 32 || !signingKey || signingKey.length < 32) throw new Error('图片存储服务尚未配置');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('图片存储必须使用 HTTPS');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('图片存储服务地址无效');
  return { endpoint: url.origin, token, signingKey, bucket: 'workwear-images-v1' };
}
export function assertImageStoreKey(key: string) {
  const prefix = process.env.CATALOG_OSS_PREFIX || 'workwear-mockup/prod';
  const suffix = key.slice(prefix.length + 1);
  const match = /^(?:production\/)?objects\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(suffix);
  if (!key.startsWith(`${prefix}/`) || !match || match[1] !== match[2].slice(0,2)) throw new Error('图片文件不属于当前项目');
}
export async function imageStoreRequest(key: string, method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', bytes?: Buffer) {
  assertImageStoreKey(key);
  const config = imageStoreConfig();
  const token = method === 'DELETE' ? process.env.CATALOG_IMAGE_STORE_DELETE_TOKEN : config.token;
  if (!token) throw new Error('图片删除凭据尚未配置');
  const response = await fetch(`${config.endpoint}/v1/objects/${key}`, { method, headers: { Authorization: `Bearer ${token}`, ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}) }, body: bytes ? new Uint8Array(bytes) : undefined, signal: AbortSignal.timeout(method === 'DELETE' || method === 'HEAD' ? 10000 : 120000), redirect: 'error', cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 404) throw Object.assign(new Error('图片尚未存储'), { code: 'NoSuchKey' });
    throw new Error(`图片存储暂时不可用（${response.status}），本次操作尚未确认完成`);
  }
  return response;
}
export function signedImageStoreFile(key: string) {
  assertImageStoreKey(key);
  const config = imageStoreConfig(), expires = String(Math.floor(Date.now() / 1000) + 900);
  const signature = createHmac('sha256', config.signingKey).update(`GET\n${key}\n${expires}`).digest('hex');
  return `${config.endpoint}/v1/objects/${key}?expires=${expires}&signature=${signature}`;
}
