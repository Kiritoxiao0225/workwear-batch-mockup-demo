import { beforeEach, expect, it, vi } from 'vitest';
import { readArtworkRoutingReport, saveArtworkRunImage } from './artwork-routing-records';
import { catalogDatabase } from './catalog-database';
import { saveCatalogFile } from './catalog-files';

vi.mock('./production-storage', () => ({ usesProductionCloud: () => true, productionStateKey: () => 'main' }));
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));
vi.mock('./catalog-files', () => ({ saveCatalogFile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it.each(['artwork-routing-v2', 'artwork-routing-v3'])('keeps persisted %s artwork evidence readable without rerunning generation', async version => {
  const runId = 'a0000000-0000-4000-8000-000000000000';
  const report = { version, runId, graphic: { sha256: 'a'.repeat(64) } };
  vi.mocked(catalogDatabase).mockReturnValue({ query: vi.fn(async () => ({ rows: [{ record_json: report }], rowCount: 1 })) });
  expect(await readArtworkRoutingReport(runId)).toEqual(report);
});

it('accelerates model originals while keeping their audit retention and recording the verified file', async () => {
  const runId = 'a0000000-0000-4000-8000-000000000000';
  const bytes = Buffer.from('model original');
  const file = { id: 'original-file', sha256: 'a'.repeat(64), width: 10, height: 10, hasAlpha: false, byteLength: bytes.length, mimeType: 'image/png' };
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  vi.mocked(catalogDatabase).mockReturnValue({ query });
  vi.mocked(saveCatalogFile).mockResolvedValue(file);
  await saveArtworkRunImage(runId, 'generated-original', bytes);
  expect(saveCatalogFile).toHaveBeenCalledExactlyOnceWith(bytes, `${runId}-generated-original.png`);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO artwork_run_records'),
    ['main', runId, 'image:generated-original', { fileId: file.id, sha256: file.sha256 }]);
});
