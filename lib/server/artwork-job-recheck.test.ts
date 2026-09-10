import { beforeEach, expect, it, vi } from 'vitest';
import { changeArtworkJob } from './artwork-job-store';
import { ARTWORK_EDIT_INSPECTION_VERSION } from '@/lib/artwork-model-edits';

const mock = vi.hoisted(() => ({ query: vi.fn(), currentVersion: false, component: false, unknown: false }));
vi.mock('./catalog-database', () => ({ catalogDatabase: () => ({ query: mock.query }), catalogTransaction: (run: (client: { query: typeof mock.query }) => unknown) => run({ query: mock.query }) }));
vi.mock('./production-storage', () => ({ productionStateKey: () => 'test', usesProductionCloud: () => true, productionFileReferences: () => [] }));
beforeEach(() => {
  mock.currentVersion = false; mock.component = false; mock.unknown = false;
  mock.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT * FROM artwork_jobs')) return { rows: [{ id: 'job', status: 'review', candidate: { stage: 'edit-review', runId: 'run' } }], rowCount: 1 };
    if (sql.startsWith('SELECT record_json')) return { rows: [{ record_json: mock.component ? { component: 'styled-text-0' } : { prompt: 'paid original prompt' } }], rowCount: 1 };
    if (sql.includes("result->>'inspectionVersion'")) return { rows: mock.currentVersion ? [{}] : [], rowCount: Number(mock.currentVersion) };
    if (sql.includes("stage='generation'")) return { rows: mock.unknown ? [{}] : [], rowCount: Number(mock.unknown) };
    return { rows: [], rowCount: 1 };
  });
});

it('queues an outdated full-image review without deleting or retrying generation checkpoints', async () => {
  await changeArtworkJob('job', 'retry');
  const calls = mock.query.mock.calls.map(call => call[0] as string);
  expect(calls[0]).toContain('FOR UPDATE');
  expect(calls.filter(sql => /^(UPDATE|DELETE|INSERT)/u.test(sql))).toEqual([expect.stringContaining("UPDATE artwork_jobs SET status='queued'")]);
  expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("result->>'inspectionVersion'"), ['job', ARTWORK_EDIT_INSPECTION_VERSION]);
});
it.each(['currentVersion', 'component', 'unknown'] as const)('rejects unsafe or redundant reinspection: %s', async field => {
  mock[field] = true;
  await expect(changeArtworkJob('job', 'retry')).rejects.toThrow();
  expect(mock.query.mock.calls.some(call => /^(UPDATE|DELETE|INSERT)/u.test(call[0]))).toBe(false);
});
