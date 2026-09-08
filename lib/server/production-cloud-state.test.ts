import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitCloudProductionState } from './production-cloud-state';
import { catalogTransaction } from './catalog-database';
import { emptyWpsProductionState } from '../wps-production';

vi.mock('./catalog-database', () => ({ catalogTransaction: vi.fn(), catalogDatabase: vi.fn() }));
const query = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT revision') ? [{ revision: 0 }] : [], rowCount: 0 }));
  vi.mocked(catalogTransaction).mockImplementation(async work => work({ query }));
});
describe('position-only production commits', () => {
  it('keeps existing file references and render pointers under the same revision lock', async () => {
    const current = emptyWpsProductionState();
    const next = { ...current, revision: 1, budgetCny: 42 };
    expect(await commitCloudProductionState(current, next)).toBe(true);
    expect(query.mock.calls.map(([sql]) => sql)).toHaveLength(2);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1][0]).toContain('UPDATE production_states');
  });
  it('does not save or update references after a stale revision', async () => {
    query.mockResolvedValue({ rows: [{ revision: 2 }], rowCount: 1 });
    const current = emptyWpsProductionState();
    expect(await commitCloudProductionState(current, { ...current, revision: 1 })).toBe(false);
    expect(query).toHaveBeenCalledOnce();
  });
  it('rolls back when the reference-protection trigger rejects a changed file', async () => {
    const current = emptyWpsProductionState();
    const next = { ...current, revision: 1, fixtureFile: '/api/production-files/70343173-0383-41e2-9990-ac68984c0c1d' };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO production_file_refs')) throw new Error('File is not ready for a new reference');
      return { rows: [{ revision: 0 }], rowCount: 1 };
    });
    await expect(commitCloudProductionState(current, next)).rejects.toThrow('not ready');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO production_file_refs');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE production_states'))).toBe(false);
  });
  it('only adds the new customer-image reference, preserving all unchanged references', async () => {
    const existing = '/api/production-files/70343173-0383-41e2-9990-ac68984c0c1d';
    const current = { ...emptyWpsProductionState(), fixtureFile: existing };
    const next = { ...current, revision: 1, customerFile: '/api/production-files/d028d35a-59d1-4341-aed6-c9c7f8f72d06' };
    await commitCloudProductionState(current, next);
    expect(query.mock.calls[1][1][1]).toEqual([{ ref: '/customerFile', id: 'd028d35a-59d1-4341-aed6-c9c7f8f72d06' }]);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
  });
  it('keeps save receipts in the same transaction on the fast path', async () => {
    const current = emptyWpsProductionState();
    await commitCloudProductionState(current, { ...current, revision: 1 }, { id: 'save-id', hash: 'hash' });
    expect(query.mock.calls.at(-1)?.[0]).toContain('INSERT INTO production_save_receipts');
  });
});
