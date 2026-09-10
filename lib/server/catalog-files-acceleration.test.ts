import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OSS from 'ali-oss';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { fileSha256, readCatalogFile, saveCatalogFile, signedCatalogFile, signedCatalogThumbnails } from './catalog-files';

vi.mock('ali-oss', () => ({ default: vi.fn() }));
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn(), catalogTransaction: vi.fn() }));
const bytes = Buffer.from('verified image bytes');
const get = vi.fn();
const put = vi.fn();
const sign = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CATALOG_LOCAL_OBJECT_ROOT', '');
  vi.stubEnv('CATALOG_OSS_BUCKET', 'test-bucket');
  vi.stubEnv('CATALOG_OSS_REGION', 'oss-cn-beijing');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_ID', 'test-id');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_SECRET', 'test-secret');
  vi.stubEnv('CATALOG_OSS_PREFIX', 'workwear-mockup/prod');
  vi.mocked(OSS).mockImplementation(function () { return { get, put, signatureUrlV4: sign } as unknown as OSS; });
  get.mockResolvedValue({ content: bytes });
  const file = { id: 'file-1', backend: 'oss', bucket: 'test-bucket', gc_state: 'active',
    object_key: `workwear-mockup/prod/production/objects/${fileSha256(bytes).slice(0, 2)}/${fileSha256(bytes)}`,
    object_version_id: 'version-1', sha256: fileSha256(bytes) };
  vi.mocked(catalogDatabase).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [file], rowCount: 1 }) });
});
afterEach(() => vi.unstubAllEnvs());

it.each(['objects', 'production/objects'])('accelerates default server reads from %s while preserving version and byte verification', async prefix => {
  const file = (await catalogDatabase().query('fixture')).rows[0];
  file.object_key = `workwear-mockup/prod/${prefix}/${fileSha256(bytes).slice(0, 2)}/${fileSha256(bytes)}`;
  expect((await readCatalogFile('file-1')).bytes).toEqual(bytes);
  expect(vi.mocked(OSS).mock.calls[0][0]).toMatchObject({ endpoint: 'https://oss-accelerate.aliyuncs.com', region: 'oss-cn-beijing', authorizationV4: true });
  expect(get).toHaveBeenCalledWith(expect.any(String), { versionId: 'version-1' });
});
it('keeps browser original and thumbnail signatures on the regional endpoint without downloading images on the server', async () => {
  await signedCatalogFile('file-1');
  await signedCatalogThumbnails(['/api/catalog/files/a0000000-0000-4000-8000-000000000000']);
  for (const [config] of vi.mocked(OSS).mock.calls) expect(config).not.toHaveProperty('endpoint');
  expect(sign).toHaveBeenCalledTimes(2);
  expect(get).not.toHaveBeenCalled();
});
it('rejects corrupted content even when the accelerated request succeeds', async () => {
  get.mockResolvedValue({ content: Buffer.from('incorrect bytes') });
  await expect(readCatalogFile('file-1')).rejects.toThrow('文件内容校验失败');
});

it.each([
  { purpose: 'catalog' as const, prefix: 'objects/' },
  { purpose: 'production' as const, prefix: 'production/objects/' },
])('accelerates default $purpose uploads and readback without changing their retention prefix', async ({ purpose, prefix }) => {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#b41230' } }).png().toBuffer();
  const hash = fileSha256(image);
  const key = `workwear-mockup/prod/${prefix}${hash.slice(0, 2)}/${hash}`;
  const query = vi.fn(async (sql: string) => sql.includes('RETURNING id,status')
    ? { rows: [{ id: 'audit-1', status: 'pending', object_key: key, gc_state: 'active' }], rowCount: 1 }
    : { rows: [], rowCount: 0 });
  vi.mocked(catalogDatabase).mockReturnValue({ query });
  vi.mocked(catalogTransaction).mockImplementation(async operation => operation({ query }));
  get.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'NoSuchKey' }))
    .mockResolvedValueOnce({ content: image, res: { headers: { 'x-oss-version-id': 'uploaded-v1' } } });
  put.mockResolvedValue({ res: { headers: { 'x-oss-version-id': 'uploaded-v1' } } });

  expect(await saveCatalogFile(image, 'audit-original.png', purpose)).toMatchObject({ id: 'audit-1', sha256: hash });
  const config = vi.mocked(OSS).mock.calls[0][0];
  expect(config).toMatchObject({ endpoint: 'https://oss-accelerate.aliyuncs.com' });
  expect(put).toHaveBeenCalledExactlyOnceWith(key, image, expect.objectContaining({
    headers: expect.objectContaining({ 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private' }),
  }));
  expect(get).toHaveBeenNthCalledWith(1, key);
  expect(get).toHaveBeenNthCalledWith(2, key, { versionId: 'uploaded-v1' });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("status='ready'"), ['audit-1', 'uploaded-v1']);
});

it.each(['bucket', 'prefix'])('rejects a file outside the configured %s before making an OSS request', async mismatch => {
  const file = (await catalogDatabase().query('fixture')).rows[0];
  if (mismatch === 'bucket') file.bucket = 'another-bucket';
  else file.object_key = `another-project/objects/${fileSha256(bytes).slice(0, 2)}/${fileSha256(bytes)}`;
  await expect(readCatalogFile('file-1')).rejects.toThrow(mismatch === 'bucket' ? 'Bucket' : '目录');
  expect(OSS).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});
