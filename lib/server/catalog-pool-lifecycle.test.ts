import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ after: vi.fn(), postgres: vi.fn() }));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('postgres', () => ({ default: mocks.postgres }));
import { catalogDatabase, catalogTransaction, closeCatalogDatabase } from './catalog-database';
const callbacks: Array<() => Promise<void>> = [];
function pool() {
  const reserved = { unsafe: vi.fn().mockResolvedValue([]), release: vi.fn() };
  return { unsafe: vi.fn().mockResolvedValue([]), end: vi.fn().mockResolvedValue(undefined), reserve: vi.fn().mockResolvedValue(reserved), reserved };
}
beforeEach(() => {
  vi.clearAllMocks(); callbacks.length = 0;
  vi.stubEnv('VERCEL', '1'); vi.stubEnv('CATALOG_DATABASE_URL', 'postgresql://app:test@localhost/test');
  mocks.after.mockImplementation(callback => callbacks.push(callback));
});
afterEach(async () => { await closeCatalogDatabase(); vi.unstubAllEnvs(); });
describe('serverless database lifecycle', () => {
  it('closes an idle pool after the response and reconnects on the next query', async () => {
    const first = pool(), second = pool(); mocks.postgres.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const db = catalogDatabase(); await db.query('SELECT 1');
    expect(first.end).not.toHaveBeenCalled(); await callbacks.shift()!(); expect(first.end).toHaveBeenCalledOnce();
    await db.query('SELECT 2'); expect(second.unsafe).toHaveBeenCalledWith('SELECT 2', []);
    expect(mocks.postgres.mock.calls[0][1].max).toBe(1);
  });
  it('keeps a concurrent transaction alive and closes only after its own response', async () => {
    const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1');
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    const transaction = catalogTransaction(async client => { await pending; return client.query('SELECT 2'); });
    await callbacks.shift()!(); expect(current.end).not.toHaveBeenCalled();
    finish(); await transaction;
    expect(current.reserved.release).toHaveBeenCalledOnce();
    await callbacks.shift()!(); expect(current.end).toHaveBeenCalledOnce();
  });
  it('closes the pool after a failed query too', async () => {
    const current = pool(); current.unsafe.mockRejectedValue(new Error('read failed')); mocks.postgres.mockReturnValue(current);
    await expect(catalogDatabase().query('SELECT 1')).rejects.toThrow('read failed');
    await callbacks.shift()!(); expect(current.end).toHaveBeenCalledOnce();
  });
  it('retains the normal reusable pool for local scripts', async () => {
    vi.stubEnv('VERCEL', ''); const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1'); expect(mocks.after).not.toHaveBeenCalled(); expect(current.end).not.toHaveBeenCalled();
  });
});
