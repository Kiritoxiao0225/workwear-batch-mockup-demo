import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OSS from 'ali-oss';
import { catalogOssBrowserSigner, catalogOssBucketControl, catalogOssObjects } from './catalog-oss';

vi.mock('ali-oss', () => ({ default: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CATALOG_OSS_REGION', 'oss-cn-beijing');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_ID', 'read-write-id');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_SECRET', 'read-write-secret');
  vi.stubEnv('PRODUCTION_DELETE_ACCESS_KEY_ID', 'delete-id');
  vi.stubEnv('PRODUCTION_DELETE_ACCESS_KEY_SECRET', 'delete-secret');
});
afterEach(() => vi.unstubAllEnvs());

it('uses acceleration and the original credential scopes for image transfers and cleanup', () => {
  catalogOssObjects('test-bucket');
  catalogOssObjects('test-bucket', 'cleanup');
  expect(OSS).toHaveBeenNthCalledWith(1, expect.objectContaining({ bucket: 'test-bucket', accessKeyId: 'read-write-id',
    endpoint: 'https://oss-accelerate.aliyuncs.com', secure: true, authorizationV4: true, timeout: 120000 }));
  expect(OSS).toHaveBeenNthCalledWith(2, expect.objectContaining({ bucket: 'test-bucket', accessKeyId: 'delete-id',
    endpoint: 'https://oss-accelerate.aliyuncs.com', secure: true, authorizationV4: true, timeout: 5000 }));
});

it('keeps browser signing and bucket management regional without changing credential scopes', () => {
  catalogOssBrowserSigner('test-bucket');
  catalogOssBucketControl('test-bucket');
  const [signer, control] = vi.mocked(OSS).mock.calls.map(([config]) => config);
  expect(signer).not.toHaveProperty('endpoint');
  expect(control).not.toHaveProperty('endpoint');
  expect(signer).toMatchObject({ accessKeyId: 'read-write-id', secure: true, authorizationV4: true });
  expect(control).toMatchObject({ accessKeyId: 'delete-id', secure: true, authorizationV4: true });
});

it('fails closed when cleanup credentials are missing, without falling back to the read-write account', () => {
  vi.stubEnv('PRODUCTION_DELETE_ACCESS_KEY_ID', '');
  expect(() => catalogOssObjects('test-bucket', 'cleanup')).toThrow('PRODUCTION_DELETE_ACCESS_KEY_ID');
  expect(() => catalogOssBucketControl('test-bucket')).toThrow('PRODUCTION_DELETE_ACCESS_KEY_ID');
  expect(OSS).not.toHaveBeenCalled();
});
