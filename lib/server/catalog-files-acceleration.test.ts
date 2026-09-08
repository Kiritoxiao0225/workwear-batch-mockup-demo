import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OSS from 'ali-oss';
import { catalogDatabase } from './catalog-database';
import { fileSha256, readCatalogFile, signedCatalogFile } from './catalog-files';

vi.mock('ali-oss', () => ({ default: vi.fn() }));
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));
const bytes = Buffer.from('verified image bytes');
const get = vi.fn();
const sign = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CATALOG_LOCAL_OBJECT_ROOT', '');
  vi.stubEnv('CATALOG_OSS_BUCKET', 'test-bucket');
  vi.stubEnv('CATALOG_OSS_REGION', 'oss-cn-beijing');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_ID', 'test-id');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_SECRET', 'test-secret');
  vi.stubEnv('CATALOG_OSS_PREFIX', 'workwear-mockup/prod');
  vi.mocked(OSS).mockImplementation(function () { return { get, signatureUrlV4: sign } as unknown as OSS; });
  get.mockResolvedValue({ content: bytes });
  const file = { id: 'file-1', backend: 'oss', bucket: 'test-bucket', gc_state: 'active',
    object_key: `workwear-mockup/prod/production/objects/${fileSha256(bytes).slice(0, 2)}/${fileSha256(bytes)}`,
    object_version_id: 'version-1', sha256: fileSha256(bytes) };
  vi.mocked(catalogDatabase).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [file], rowCount: 1 }) });
});
afterEach(() => vi.unstubAllEnvs());

it('opts production reads into acceleration while preserving version and byte verification', async () => {
  expect((await readCatalogFile('file-1', { accelerated: true })).bytes).toEqual(bytes);
  expect(vi.mocked(OSS).mock.calls[0][0]).toMatchObject({ endpoint: 'https://oss-accelerate.aliyuncs.com', region: 'oss-cn-beijing', authorizationV4: true });
  expect(get).toHaveBeenCalledWith(expect.any(String), { versionId: 'version-1' });
});
it('keeps ordinary catalog reads and browser signed URLs on the regional endpoint', async () => {
  await readCatalogFile('file-1');
  await signedCatalogFile('file-1');
  for (const [config] of vi.mocked(OSS).mock.calls) expect(config).not.toHaveProperty('endpoint');
  expect(sign).toHaveBeenCalled();
});
it('rejects corrupted content even when the accelerated request succeeds', async () => {
  get.mockResolvedValue({ content: Buffer.from('incorrect bytes') });
  await expect(readCatalogFile('file-1', { accelerated: true })).rejects.toThrow('文件内容校验失败');
});
