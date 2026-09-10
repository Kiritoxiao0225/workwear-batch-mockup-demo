import { beforeEach, expect, it, vi } from 'vitest';
import { readArtworkRoutingReport } from './artwork-routing-records';
import { catalogDatabase } from './catalog-database';

vi.mock('./production-storage', () => ({ usesProductionCloud: () => true, productionStateKey: () => 'main' }));
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it.each(['artwork-routing-v2', 'artwork-routing-v3'])('keeps persisted %s artwork evidence readable without rerunning generation', async version => {
  const runId = 'a0000000-0000-4000-8000-000000000000';
  const report = { version, runId, graphic: { sha256: 'a'.repeat(64) } };
  vi.mocked(catalogDatabase).mockReturnValue({ query: vi.fn(async () => ({ rows: [{ record_json: report }], rowCount: 1 })) });
  expect(await readArtworkRoutingReport(runId)).toEqual(report);
});
