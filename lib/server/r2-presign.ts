import { createHash, createHmac } from 'node:crypto';

/**
 * 生成 R2（S3 兼容）的 SigV4 预签名 GET URL。
 *
 * 这里手写而不是用 @aws-sdk/s3-request-presigner，是为了不引入新的直接依赖：
 * 项目现有的依赖树里没有这个包，而部署环境执行的是 `npm ci`，
 * 单方面新增 package.json 依赖却不更新 lock 会让 `npm ci` 直接失败。
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** AWS 要求 RFC 3986 编码：encodeURIComponent 会漏掉 !'()* 这几个字符。 */
function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key: string) {
  return key.split('/').map(encodeRfc3986).join('/');
}

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function amzDateParts(now: Date) {
  // toISOString 去掉分隔符后即为 YYYYMMDDTHHMMSSZ，不要再手工补 T。
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { timestamp, date: timestamp.slice(0, 8) };
}

export type PresignOptions = {
  endpoint: string;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn: number;
  now?: Date;
};

export function presignR2GetUrl(options: PresignOptions) {
  const { endpoint, bucket, key, region, accessKeyId, secretAccessKey, expiresIn } = options;
  const url = new URL(endpoint);
  // R2 走虚拟主机风格：桶名作为子域，路径只保留对象名。
  const host = `${bucket}.${url.host}`;
  const canonicalUri = `/${encodeKeyPath(key)}`;
  const { timestamp, date } = amzDateParts(options.now ?? new Date());
  const scope = `${date}/${region}/${SERVICE}/aws4_request`;

  const query = new Map<string, string>([
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', timestamp],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);
  const canonicalQuery = [...query.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join('&');

  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', UNSIGNED_PAYLOAD].join('\n');
  const stringToSign = [ALGORITHM, timestamp, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), SERVICE), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${url.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
