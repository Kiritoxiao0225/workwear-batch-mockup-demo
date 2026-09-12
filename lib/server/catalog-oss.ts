import OSS from 'ali-oss';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { presignR2GetUrl } from './r2-presign';

type Credentials = 'catalog' | 'cleanup';
type BucketControl = { getBucketVersioning(bucket: string): Promise<{ versionStatus?: string }> };

const R2_REGION = 'auto';

/**
 * 对象存储提供方，由 CATALOG_OBJECT_STORE 显式指定，默认沿用阿里云 OSS。
 *
 * 关键约定：数据库 files.bucket 存的是**逻辑桶名**（CATALOG_OSS_BUCKET）。
 * 切换提供方时逻辑桶名不变，只有适配器内部把它映射到 R2 的物理桶
 * （CATALOG_R2_BUCKET）。所以切换与回滚都只改环境变量，数据库不动。
 */
export function catalogObjectStore(): 'oss' | 'r2' {
  const value = process.env.CATALOG_OBJECT_STORE?.trim() || 'oss';
  if (value !== 'oss' && value !== 'r2') throw new Error(`CATALOG_OBJECT_STORE 只能是 oss 或 r2：${value}`);
  return value;
}

// ---------------------------------------------------------------------------
// 阿里云 OSS
// ---------------------------------------------------------------------------

// Keep endpoint selection here. Retention prefixes and caller names do not
// determine transport; every server-side image operation uses acceleration.
function ossClient(bucket: string, credentials: Credentials, accelerated: boolean) {
  const prefix = credentials === 'cleanup' ? 'PRODUCTION_DELETE' : 'CATALOG_OSS';
  const accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`];
  const accessKeySecret = process.env[`${prefix}_ACCESS_KEY_SECRET`];
  const region = process.env.CATALOG_OSS_REGION;
  if (!bucket || !region || !accessKeyId || !accessKeySecret) throw new Error(`OSS 尚未配置 Bucket / REGION / ${prefix}_ACCESS_KEY_ID / SECRET`);
  return new OSS({ bucket, region, accessKeyId, accessKeySecret, secure: true, authorizationV4: true,
    timeout: credentials === 'cleanup' ? 5000 : 120000,
    ...(accelerated ? { endpoint: 'https://oss-accelerate.aliyuncs.com' } : {}),
  });
}

// ---------------------------------------------------------------------------
// Cloudflare R2（S3 兼容）
// ---------------------------------------------------------------------------

function r2Bucket(logicalBucket: string) {
  const physical = process.env.CATALOG_R2_BUCKET;
  if (!logicalBucket || !physical) throw new Error('R2 尚未配置 CATALOG_R2_BUCKET');
  return physical;
}

function r2Credentials(credentials: Credentials) {
  const prefix = credentials === 'cleanup' ? 'PRODUCTION_DELETE_R2' : 'CATALOG_R2';
  let accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`];
  let accessKeySecret = process.env[`${prefix}_ACCESS_KEY_SECRET`];
  // R2 的令牌权限没有"只删不读"档位，删除无法像 OSS 那样用独立最小权限账号隔离；
  // 未单独配置时沿用主凭据，该差异已在运维文档中说明。
  if (credentials === 'cleanup' && (!accessKeyId || !accessKeySecret)) {
    accessKeyId = process.env.CATALOG_R2_ACCESS_KEY_ID;
    accessKeySecret = process.env.CATALOG_R2_ACCESS_KEY_SECRET;
  }
  const endpoint = process.env.CATALOG_R2_ENDPOINT;
  if (!accessKeyId || !accessKeySecret || !endpoint) throw new Error(`R2 尚未配置 CATALOG_R2_ENDPOINT / ${prefix}_ACCESS_KEY_ID / SECRET`);
  return { endpoint, accessKeyId, accessKeySecret };
}

function r2Client(credentials: Credentials) {
  const { endpoint, accessKeyId, accessKeySecret } = r2Credentials(credentials);
  return new S3Client({
    region: R2_REGION,
    endpoint,
    credentials: { accessKeyId, secretAccessKey: accessKeySecret },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

type ObjectOptions = { versionId?: string | null; timeout?: number };
type PutOptions = { mime?: string; headers?: Record<string, string> };

const httpStatus = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const notFound = (error: unknown) => {
  const candidate = error as { name?: string; Code?: string };
  return httpStatus(error) === 404 || ['NoSuchKey', 'NotFound', 'NoSuchVersion'].includes(String(candidate?.name ?? candidate?.Code ?? ''));
};

/** 把 S3 错误翻译成调用方已在使用的 ali-oss 错误码，消费方无需感知底层差异。 */
async function normalize<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (notFound(error)) throw Object.assign(new Error('对象不存在'), { code: 'NoSuchKey', name: 'NoSuchKey' });
    if (httpStatus(error) === 412) throw Object.assign(new Error('对象已存在'), { code: 'FileAlreadyExists', name: 'FileAlreadyExists' });
    throw error;
  }
}

/**
 * R2 无法按版本读取，也没有对象级 ACL。OSS 专有参数在这里就地翻译：
 * x-oss-forbid-overwrite → If-None-Match，versionId 与对象 ACL 直接忽略。
 */
function r2Objects(logicalBucket: string, credentials: Credentials) {
  const client = r2Client(credentials);
  const Bucket = r2Bucket(logicalBucket);
  function send<T>(command: GetObjectCommand): Promise<T>;
  function send<T>(command: HeadObjectCommand | DeleteObjectCommand | PutObjectCommand, timeout?: number): Promise<T>;
  function send<T>(command: object, timeout?: number): Promise<T> {
    const run = () => client.send(command as GetObjectCommand) as Promise<T>;
    if (!timeout) return normalize(run);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return normalize(() => client.send(command as GetObjectCommand, { abortSignal: controller.signal }) as Promise<T>)
      .finally(() => clearTimeout(timer));
  }
  return {
    async get(key: string) {
      const result = await send<{ Body: { transformToByteArray(): Promise<Uint8Array> } }>(new GetObjectCommand({ Bucket, Key: key }));
      return { content: Buffer.from(await result.Body.transformToByteArray()), res: { headers: {} as Record<string, unknown> } };
    },
    async put(key: string, body: Buffer, options?: PutOptions) {
      const headers = options?.headers ?? {};
      const forbidOverwrite = String(headers['x-oss-forbid-overwrite'] ?? '').toLowerCase() === 'true';
      await send(new PutObjectCommand({ Bucket, Key: key, Body: body,
        ...(options?.mime ? { ContentType: options.mime } : {}),
        ...(headers['Cache-Control'] ? { CacheControl: headers['Cache-Control'] } : {}),
        ...(forbidOverwrite ? { IfNoneMatch: '*' } : {}),
      }));
      return { res: { headers: {} as Record<string, unknown> } };
    },
    async head(key: string, options?: ObjectOptions) {
      const result = await send<{ ContentLength?: number }>(new HeadObjectCommand({ Bucket, Key: key }), options?.timeout);
      return { res: { headers: { 'content-length': String(result.ContentLength ?? '') } as Record<string, unknown> } };
    },
    async delete(key: string, options?: ObjectOptions) {
      await send(new DeleteObjectCommand({ Bucket, Key: key }), options?.timeout);
    },
  };
}

function r2Signer(logicalBucket: string) {
  const Bucket = r2Bucket(logicalBucket);
  const { endpoint, accessKeyId, accessKeySecret } = r2Credentials('catalog');
  return {
    async signatureUrlV4(_method: string, expires: number, _options?: { queries?: Record<string, string> }, key?: string) {
      if (!key) throw new Error('签名 URL 缺少对象名');
      // R2 不支持对象版本控制，调用方带来的 versionId 查询参数在此忽略。
      return presignR2GetUrl({ endpoint, bucket: Bucket, key, region: R2_REGION,
        accessKeyId, secretAccessKey: accessKeySecret, expiresIn: expires });
    },
  };
}

// ---------------------------------------------------------------------------
// 对外接口：沿用原有函数名与导入路径，消费方一行都不用改
// ---------------------------------------------------------------------------

/** Upload, download, verify and delete objects through the same accelerated endpoint. */
export function catalogOssObjects(bucket: string, credentials: Credentials = 'catalog'): Pick<OSS, 'get' | 'put' | 'head' | 'delete'> {
  if (catalogObjectStore() === 'r2') return r2Objects(bucket, credentials) as unknown as Pick<OSS, 'get' | 'put' | 'head' | 'delete'>;
  return ossClient(bucket, credentials, true);
}

/** Browser downloads retain regional URLs; this interface cannot transfer server-side images. */
export function catalogOssBrowserSigner(bucket: string): Pick<OSS, 'signatureUrlV4'> {
  if (catalogObjectStore() === 'r2') return r2Signer(bucket) as unknown as Pick<OSS, 'signatureUrlV4'>;
  return ossClient(bucket, 'catalog', false);
}

/** Bucket management uses its regional endpoint and the existing cleanup credentials. */
export function catalogOssBucketControl(bucket: string): BucketControl {
  if (catalogObjectStore() === 'r2') {
    // R2 没有桶级版本控制。返回空结果即代表"未开启版本控制"，
    // 删除流程会走"直接删对象并核对已不存在"的分支。
    return { getBucketVersioning: async () => ({ versionStatus: undefined }) };
  }
  return ossClient(bucket, 'cleanup', false) as OSS & BucketControl;
}
