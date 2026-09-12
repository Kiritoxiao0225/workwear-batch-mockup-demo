import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () { return { send }; }),
  GetObjectCommand: vi.fn(function (input: unknown) { return { kind: 'Get', input }; }),
  PutObjectCommand: vi.fn(function (input: unknown) { return { kind: 'Put', input }; }),
  HeadObjectCommand: vi.fn(function (input: unknown) { return { kind: 'Head', input }; }),
  DeleteObjectCommand: vi.fn(function (input: unknown) { return { kind: 'Delete', input }; }),
}));

import { catalogOssBrowserSigner, catalogOssBucketControl, catalogOssObjects, catalogObjectStore } from './catalog-oss';

const inputOf = (call: number) => send.mock.calls[call][0].input as Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    CATALOG_OBJECT_STORE: 'r2',
    CATALOG_OSS_BUCKET: 'logical-bucket',
    CATALOG_R2_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
    CATALOG_R2_BUCKET: 'physical-bucket',
    CATALOG_R2_ACCESS_KEY_ID: 'r2-id',
    CATALOG_R2_ACCESS_KEY_SECRET: 'r2-secret',
  })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

it('treats a missing provider setting as OSS so existing deployments keep working', () => {
  vi.stubEnv('CATALOG_OBJECT_STORE', '');
  expect(catalogObjectStore()).toBe('oss');
});

it('rejects an unknown provider instead of guessing', () => {
  vi.stubEnv('CATALOG_OBJECT_STORE', 'gcs');
  expect(() => catalogObjectStore()).toThrow('CATALOG_OBJECT_STORE');
});

it('maps the logical bucket to the physical R2 bucket on every call', async () => {
  send.mockResolvedValue({ Body: { transformToByteArray: async () => Buffer.from('x') } });
  await catalogOssObjects('logical-bucket').get('workwear-mockup/prod/objects/aa/' + 'a'.repeat(64));
  expect(inputOf(0)).toMatchObject({ Bucket: 'physical-bucket' });
});

it('translates x-oss-forbid-overwrite into a conditional write and drops OSS-only headers', async () => {
  send.mockResolvedValue({});
  await catalogOssObjects('logical-bucket').put('key', Buffer.from('bytes'), {
    mime: 'image/png',
    headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private', 'Cache-Control': 'private, max-age=86400' },
  });
  expect(inputOf(0)).toMatchObject({ IfNoneMatch: '*', ContentType: 'image/png', CacheControl: 'private, max-age=86400' });
  expect(inputOf(0)).not.toHaveProperty('x-oss-object-acl');
});

it('reports an existing object with the same error code the OSS path used', async () => {
  send.mockRejectedValue(Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } }));
  await expect(catalogOssObjects('logical-bucket').put('key', Buffer.from('bytes'))).rejects.toMatchObject({ code: 'FileAlreadyExists' });
});

it('reports a missing object as NoSuchKey for both read and head so absence checks keep working', async () => {
  send.mockRejectedValue(Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }));
  await expect(catalogOssObjects('logical-bucket').get('key')).rejects.toMatchObject({ code: 'NoSuchKey' });
  await expect(catalogOssObjects('logical-bucket').head('key')).rejects.toMatchObject({ code: 'NoSuchKey' });
});

it('ignores a stored OSS version id instead of sending a request R2 rejects with 501', async () => {
  send.mockResolvedValue({ Body: { transformToByteArray: async () => Buffer.from('bytes') } });
  await catalogOssObjects('logical-bucket').get('key', { versionId: 'oss-version-1' });
  expect(inputOf(0)).not.toHaveProperty('VersionId');
});

it('reports no bucket versioning because R2 does not support it', async () => {
  expect(await catalogOssBucketControl('logical-bucket').getBucketVersioning('logical-bucket')).toEqual({ versionStatus: undefined });
});

it('signs browser downloads against the physical bucket without a version query', async () => {
  const url = await catalogOssBrowserSigner('logical-bucket')
    .signatureUrlV4('GET', 900, { queries: { versionId: 'oss-version-1' } }, 'workwear-mockup/prod/objects/aa/f.bin');
  expect(url).toContain('https://physical-bucket.accountid.r2.cloudflarestorage.com/');
  expect(url).toContain('X-Amz-Signature=');
  expect(url).not.toContain('versionId');
});

it('fails closed when R2 credentials are missing', () => {
  vi.stubEnv('CATALOG_R2_ACCESS_KEY_ID', '');
  expect(() => catalogOssObjects('logical-bucket')).toThrow('CATALOG_R2_ACCESS_KEY_ID');
});
