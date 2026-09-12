import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { S3Client } from '@aws-sdk/client-s3';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { catalogStorageConfig, fileSha256, readCatalogFile, saveCatalogFile, signedCatalogFile } from './catalog-files';
import { cleanupReplacedFiles } from './production-replaced-files';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () { return { send }; }),
  GetObjectCommand: vi.fn(function (input) { return { kind: 'get', input }; }),
  PutObjectCommand: vi.fn(function (input) { return { kind: 'put', input }; }),
  HeadObjectCommand: vi.fn(function (input) { return { kind: 'head', input }; }),
  DeleteObjectCommand: vi.fn(function (input) { return { kind: 'delete', input }; }),
}));
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn(), catalogTransaction: vi.fn() }));

const query = vi.fn();
const id = 'a0000000-0000-4000-8000-000000000000';
let bytes: Buffer, file: Record<string, unknown>, transactionOpen: boolean;
beforeEach(async () => {
  vi.clearAllMocks(); query.mockReset(); send.mockReset();
  transactionOpen = false;
  for (const [key, value] of Object.entries({
    CATALOG_LOCAL_OBJECT_ROOT: '', CATALOG_IMAGE_STORAGE: 'oss', CATALOG_OBJECT_STORE: 'r2',
    CATALOG_OSS_BUCKET: 'logical-bucket', CATALOG_OSS_PREFIX: 'workwear-mockup/prod',
    CATALOG_OSS_REGION: '', CATALOG_OSS_ACCESS_KEY_ID: '', CATALOG_OSS_ACCESS_KEY_SECRET: '',
    PRODUCTION_DELETE_ACCESS_KEY_ID: '', PRODUCTION_DELETE_ACCESS_KEY_SECRET: '',
    PRODUCTION_DELETE_R2_ACCESS_KEY_ID: '', PRODUCTION_DELETE_R2_ACCESS_KEY_SECRET: '',
    CATALOG_R2_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com', CATALOG_R2_BUCKET: 'physical-bucket',
    CATALOG_R2_ACCESS_KEY_ID: 'r2-id', CATALOG_R2_ACCESS_KEY_SECRET: 'r2-secret',
  })) vi.stubEnv(key, value);
  bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#156a92' } }).png().toBuffer();
  const hash = fileSha256(bytes);
  file = { id, backend: 'oss', bucket: 'logical-bucket', status: 'ready', gc_state: 'active',
    object_key: `workwear-mockup/prod/production/objects/${hash.slice(0, 2)}/${hash}`,
    object_version_id: null, sha256: hash, mime_type: 'image/png', width: 8, height: 8, byte_length: bytes.length, has_alpha: true };
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT substring')) return { rows: [{ id }], rowCount: 1 };
    if (sql.startsWith('SELECT * FROM files')) return { rows: [file], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  vi.mocked(catalogDatabase).mockReturnValue({ query });
  vi.mocked(catalogTransaction).mockImplementation(async operation => {
    transactionOpen = true;
    try { return await operation({ query }); } finally { transactionOpen = false; }
  });
  send.mockImplementation(async (command: { kind: string }) => {
    expect(transactionOpen).toBe(false);
    if (command.kind === 'get') return { Body: { transformToByteArray: async () => bytes } };
    if (command.kind === 'head') throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());

it('reads and signs existing logical OSS file IDs using only R2 credentials', async () => {
  expect(catalogStorageConfig()).toEqual({ backend: 'oss', bucket: 'logical-bucket' });
  expect((await readCatalogFile(id)).bytes).toEqual(bytes);
  const url = await signedCatalogFile(id);
  expect(new URL(url!).hostname).toBe('physical-bucket.accountid.r2.cloudflarestorage.com');
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'get', input: { Bucket: 'physical-bucket', Key: file.object_key } }));
});

it('uploads and verifies new bytes outside the transaction before marking the R2 file ready and retaining its ID', async () => {
  file.status = 'pending';
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT * FROM files')) return { rows: [file], rowCount: 1 };
    if (sql.includes('RETURNING owner') || sql.startsWith('SELECT owner')) return { rows: [{ owner: 'lease' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  send.mockRejectedValueOnce(Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }));
  const retained = vi.fn(async () => { expect(transactionOpen).toBe(true); });
  expect(await saveCatalogFile(bytes, 'r2-regression.png', 'production', retained)).toMatchObject({ id, sha256: file.sha256 });
  expect(send.mock.calls.map(([c]) => c.kind)).toEqual(['get', 'put', 'get']);
  expect(send.mock.calls[1][0].input).toMatchObject({ Bucket: 'physical-bucket', Key: file.object_key, Body: bytes, IfNoneMatch: '*' });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("status='ready'"), [id, null, 1]);
  expect(retained).toHaveBeenCalledExactlyOnceWith(expect.any(Object), id);
});

it.each([false, true])('cleans an unreferenced R2 production file without OSS delete credentials (dedicated R2 credentials: %s)', async dedicated => {
  if (dedicated) {
    vi.stubEnv('PRODUCTION_DELETE_R2_ACCESS_KEY_ID', 'r2-delete-id');
    vi.stubEnv('PRODUCTION_DELETE_R2_ACCESS_KEY_SECRET', 'r2-delete-secret');
  }
  expect(await cleanupReplacedFiles()).toEqual({ deleted: [id], failures: [] });
  expect(send.mock.calls.map(([c]) => c.kind)).toEqual(['delete', 'head', 'head']);
  for (const [command] of send.mock.calls) expect(command.input).toEqual({ Bucket: 'physical-bucket', Key: file.object_key });
  expect(S3Client).toHaveBeenCalledWith(expect.objectContaining({ credentials: {
    accessKeyId: dedicated ? 'r2-delete-id' : 'r2-id', secretAccessKey: dedicated ? 'r2-delete-secret' : 'r2-secret',
  } }));
  expect(query).toHaveBeenCalledWith(expect.stringContaining("gc_state='deleted'"), [id]);
});

it('rejects incomplete R2 configuration before registering files or attempting cleanup', async () => {
  vi.stubEnv('CATALOG_R2_ACCESS_KEY_SECRET', '');
  await expect(saveCatalogFile(bytes, 'r2-regression.png')).rejects.toThrow('R2 尚未配置');
  await expect(cleanupReplacedFiles()).rejects.toThrow('R2 尚未配置');
  expect(query).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('continues rejecting OSS cleanup without its dedicated delete credentials', async () => {
  vi.stubEnv('CATALOG_OBJECT_STORE', 'oss');
  vi.stubEnv('CATALOG_OSS_REGION', 'oss-cn-beijing');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_ID', 'oss-id');
  vi.stubEnv('CATALOG_OSS_ACCESS_KEY_SECRET', 'oss-secret');
  await expect(cleanupReplacedFiles()).rejects.toThrow('PRODUCTION_DELETE_ACCESS_KEY_ID');
  expect(catalogTransaction).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
