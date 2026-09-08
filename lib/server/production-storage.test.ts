import { beforeEach, expect, it, vi } from 'vitest';
import { saveCatalogFile } from './catalog-files';
import { persistProductionReferences } from './production-storage';
vi.mock('./catalog-files', () => ({ saveCatalogFile: vi.fn(), readCatalogFile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const inline = (value: string) => `data:image/png;base64,${Buffer.from(value).toString('base64')}`;

it('uploads at most three unique files together, deduplicates roles and preserves provenance', async () => {
  let active = 0, peak = 0;
  const gates: (() => void)[] = [];
  vi.mocked(saveCatalogFile).mockImplementation(async bytes => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => gates.push(resolve));
    active--;
    return { id: bytes.toString() } as Awaited<ReturnType<typeof saveCatalogFile>>;
  });
  const input = { id: 'material', description: 'source', url: inline('one'), previewUrl: inline('two'),
    layers: [inline('one'), inline('two'), inline('three'), inline('four'), inline('five')],
    originalUrl: inline('provenance'), originalPreviewUrl: 'source-url' };
  const saving = persistProductionReferences(input);
  await vi.waitFor(() => expect(gates).toHaveLength(3));
  expect(saveCatalogFile).toHaveBeenCalledTimes(3);
  gates[0](); await vi.waitFor(() => expect(gates).toHaveLength(4));
  gates[1](); await vi.waitFor(() => expect(gates).toHaveLength(5));
  gates.slice(2).forEach(release => release());
  const output = await saving;
  expect(peak).toBe(3); expect(active).toBe(0);
  expect(saveCatalogFile).toHaveBeenCalledTimes(5);
  expect(output.originalUrl).toBe(input.originalUrl);
  expect(output.originalPreviewUrl).toBe(input.originalPreviewUrl);
  expect(output.layers[0]).toBe(output.url); expect(output.layers[1]).toBe(output.previewUrl);
  expect(input.url).toBe(inline('one'));
});

it('drains scheduled uploads on failure and returns no partially persisted value', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(saveCatalogFile).mockImplementation(async bytes => {
    if (bytes.toString() === 'bad') throw new Error('storage failure');
    await gate;
    return { id: 'good' } as Awaited<ReturnType<typeof saveCatalogFile>>;
  });
  const finished = vi.fn();
  const saving = persistProductionReferences([inline('bad'), inline('good')]).then(finished, error => error);
  await Promise.resolve(); expect(finished).not.toHaveBeenCalled();
  release(); expect((await saving).message).toBe('storage failure');
  expect(finished).not.toHaveBeenCalled();
});
