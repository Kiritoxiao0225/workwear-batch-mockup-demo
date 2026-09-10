import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OSS from 'ali-oss';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { cleanupReplacedFiles } from './production-replaced-files';

vi.mock('ali-oss', () => ({ default: vi.fn() }));
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn(), catalogTransaction: vi.fn() }));
const remove = vi.fn(), head = vi.fn(), versioning = vi.fn();
const query = vi.fn();
const fileId = 'a0000000-0000-4000-8000-000000000000';
const objectKey = `workwear-mockup/prod/production/objects/aa/${'a'.repeat(64)}`;
let file: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ CATALOG_LOCAL_OBJECT_ROOT: '', CATALOG_OSS_BUCKET: 'test-bucket',
    CATALOG_OSS_REGION: 'oss-cn-beijing', CATALOG_OSS_PREFIX: 'workwear-mockup/prod',
    CATALOG_OSS_ACCESS_KEY_ID: 'read-write-id', CATALOG_OSS_ACCESS_KEY_SECRET: 'read-write-secret',
    PRODUCTION_DELETE_ACCESS_KEY_ID: 'delete-id', PRODUCTION_DELETE_ACCESS_KEY_SECRET: 'delete-secret' })) vi.stubEnv(key, value);
  file = { id: fileId, backend: 'oss', bucket: 'test-bucket', object_key: objectKey, object_version_id: 'v1', gc_state: 'active' };
  vi.mocked(OSS).mockImplementation(function (options) {
    // Deliberately expose disjoint methods: bucket queries cannot quietly use
    // the accelerated client and deletes cannot fall back to the regional one.
    return (options?.endpoint ? { delete: remove, head } : { getBucketVersioning: versioning }) as unknown as OSS;
  });
  head.mockRejectedValue(Object.assign(new Error('missing'), { code: 'NoSuchKey' }));
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT substring')) return { rows: [{ id: fileId }], rowCount: 1 };
    if (sql.startsWith('SELECT * FROM files')) return { rows: [file], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  vi.mocked(catalogDatabase).mockReturnValue({ query });
  vi.mocked(catalogTransaction).mockImplementation(async operation => operation({ query }));
});
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, 'Enabled', 'Suspended'])('deletes and independently verifies the exact object through acceleration with versioning=%s', async versionStatus => {
  versioning.mockResolvedValue({ versionStatus });
  expect(await cleanupReplacedFiles()).toEqual({ deleted: [fileId], failures: [] });
  expect(versioning).toHaveBeenCalledExactlyOnceWith('test-bucket');
  const options = { timeout: 5000, ...(versionStatus ? { versionId: 'v1' } : {}) };
  expect(remove).toHaveBeenCalledExactlyOnceWith(objectKey, options);
  expect(head).toHaveBeenNthCalledWith(1, objectKey, options);
  expect(head).toHaveBeenNthCalledWith(2, objectKey);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("gc_state='deleted'"), [fileId]);
});

it('preserves null-version deletion for existing unversioned objects in a versioned bucket', async () => {
  file.object_version_id = null;
  versioning.mockResolvedValue({ versionStatus: 'Enabled' });
  await cleanupReplacedFiles();
  expect(remove).toHaveBeenCalledExactlyOnceWith(objectKey, { timeout: 5000, versionId: 'null' });
});

it('does not delete anything when the regional bucket metadata query fails', async () => {
  versioning.mockRejectedValue(new Error('metadata timeout'));
  await expect(cleanupReplacedFiles()).rejects.toThrow('metadata timeout');
  expect(remove).not.toHaveBeenCalled();
  expect(catalogTransaction).not.toHaveBeenCalled();
});

it('retains the queued operation when accelerated deletion fails and never declares it deleted', async () => {
  versioning.mockResolvedValue({});
  remove.mockRejectedValue(new Error('delete timeout'));
  expect(await cleanupReplacedFiles()).toEqual({ deleted: [], failures: [{ id: fileId, error: 'delete timeout' }] });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("interval '30 seconds'"), [expect.stringContaining(fileId), expect.any(String)]);
  expect(query.mock.calls.some(([sql]) => String(sql).includes("gc_state='deleted',status="))).toBe(false);
  expect(head).not.toHaveBeenCalled();
});

it('keeps audit originals outside the replaceable production prefix', async () => {
  file.object_key = `workwear-mockup/prod/objects/aa/${'a'.repeat(64)}`;
  versioning.mockResolvedValue({});
  expect(await cleanupReplacedFiles()).toEqual({ deleted: [], failures: [] });
  expect(remove).not.toHaveBeenCalled();
  expect(head).not.toHaveBeenCalled();
});
