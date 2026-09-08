import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogDatabase } from './catalog-database';
import { readCatalogFile } from './catalog-files';
import { loadBodyGeometry } from './catalog-body-geometry';

vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));
vi.mock('./catalog-files', () => ({ readCatalogFile: vi.fn(), fileSha256: (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex') }));
const query = vi.fn();
const stored = new Map<string, unknown>();
beforeEach(() => {
  vi.clearAllMocks(); stored.clear(); vi.stubEnv('CATALOG_DATABASE_URL', 'test-geometry-database');
  vi.mocked(catalogDatabase).mockReturnValue({ query });
  query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.startsWith('SELECT')) return { rows: stored.has(String(values[0])) ? [{ width_ratios: stored.get(String(values[0])) }] : [], rowCount: stored.has(String(values[0])) ? 1 : 0 };
    stored.set(String(values[0]), values[7]); return { rows: [{ input_hash: values[0] }], rowCount: 1 };
  });
});
afterEach(() => vi.unstubAllEnvs());
async function fixture(opaque = false) {
  const bytes = await sharp(Buffer.from(`<svg width="200" height="200">${opaque ? '<rect width="200" height="200" fill="white"/>' : '<path d="M80 10H120L190 45V120H160V70H145V190H55V70H40V120H10V45Z" fill="black"/>'}</svg>`)).png().toBuffer();
  return { bytes, input: { fileId: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), width: 200, height: 200, crops: [{ x: 0, y: 0, width: 1, height: 1 }] } };
}
describe('persistent body geometry', () => {
  it.each([false, true])('survives a new module instance, including unavailable geometry (%s)', async opaque => {
    const { input, bytes } = await fixture(opaque);
    const first = await loadBodyGeometry(input, bytes);
    expect(first[0] === null).toBe(opaque);
    expect(stored.size).toBe(1);
    vi.resetModules();
    const restarted = await import('./catalog-body-geometry');
    expect(await restarted.loadBodyGeometry(input)).toEqual(first);
    expect(readCatalogFile).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)![0]).toContain("f.gc_state='active'");
  });
  it('invalidates the cache for changed crops and changed image pixels', async () => {
    const { input, bytes } = await fixture();
    await loadBodyGeometry(input, bytes);
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    await loadBodyGeometry({ ...input, crops: [{ x: 0, y: 0, width: .9, height: 1 }] });
    const changed = await fixture(true);
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: changed.bytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    expect(await loadBodyGeometry({ ...input, sha256: changed.input.sha256 })).toEqual([null]);
    expect(readCatalogFile).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(3);
  });
  it('checks pixels and dimensions before storing and retries failures', async () => {
    const { input, bytes } = await fixture();
    await expect(loadBodyGeometry({ ...input, sha256: 'f'.repeat(64) }, bytes)).rejects.toThrow('底图内容已变化');
    await expect(loadBodyGeometry({ ...input, width: 201 }, bytes)).rejects.toThrow('像素尺寸已变化');
    expect(stored.size).toBe(0);
    expect((await loadBodyGeometry(input, bytes))[0]).toBeGreaterThan(0);
  });
  it('coalesces concurrent reads without retaining failed downloads', async () => {
    const { input, bytes } = await fixture();
    vi.mocked(readCatalogFile).mockRejectedValueOnce(new Error('offline'));
    await expect(loadBodyGeometry(input)).rejects.toThrow('offline');
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    const [first, second] = await Promise.all([loadBodyGeometry(input), loadBodyGeometry(input)]);
    expect(first).toEqual(second);
    expect(readCatalogFile).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(1);
  });
});
