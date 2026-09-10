import OSS from 'ali-oss';

type Credentials = 'catalog' | 'cleanup';
type BucketControl = { getBucketVersioning(bucket: string): Promise<{ versionStatus?: string }> };

// Keep endpoint selection here. Retention prefixes and caller names do not
// determine transport; every server-side image operation uses acceleration.
function client(bucket: string, credentials: Credentials, accelerated: boolean) {
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

/** Upload, download, verify and delete objects through the same accelerated endpoint. */
export function catalogOssObjects(bucket: string, credentials: Credentials = 'catalog'): Pick<OSS, 'get' | 'put' | 'head' | 'delete'> {
  return client(bucket, credentials, true);
}

/** Browser downloads retain regional URLs; this interface cannot transfer server-side images. */
export function catalogOssBrowserSigner(bucket: string): Pick<OSS, 'signatureUrlV4'> {
  return client(bucket, 'catalog', false);
}

/** Bucket management uses its regional endpoint and the existing cleanup credentials. */
export function catalogOssBucketControl(bucket: string): BucketControl {
  return client(bucket, 'cleanup', false) as OSS & BucketControl;
}
