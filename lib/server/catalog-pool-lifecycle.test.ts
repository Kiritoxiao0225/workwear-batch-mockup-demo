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
  vi.clearAllMocks(); vi.useFakeTimers(); callbacks.length = 0;
  vi.stubEnv('VERCEL', '1'); vi.stubEnv('CATALOG_DATABASE_URL', 'postgresql://app:test@localhost/test');
  mocks.after.mockImplementation(callback => callbacks.push(callback));
});
afterEach(async () => { await closeCatalogDatabase(); vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('serverless database lifecycle', () => {
  it('reuses connections across responses and gives idle sockets time to close', async () => {
    const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1');
    let settled = false;
    const grace = callbacks.shift()!().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    await catalogDatabase().query('SELECT 2');
    expect(mocks.postgres).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); await grace;
    expect(current.end).not.toHaveBeenCalled();
    expect(mocks.postgres.mock.calls[0][1]).toMatchObject({ max: 5, idle_timeout: 5 });
  });
  it('never ends a pool while background work holds a transaction', async () => {
    const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1');
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    const transaction = catalogTransaction(async client => { await pending; return client.query('SELECT 2'); });
    const grace = callbacks.shift()!();
    await vi.advanceTimersByTimeAsync(6000); await grace;
    expect(current.end).not.toHaveBeenCalled();
    finish(); await transaction;
    expect(current.reserved.release).toHaveBeenCalledOnce();
    expect(current.reserved.unsafe.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'SELECT 2', 'COMMIT']);
    const backgroundGrace = callbacks.shift()!();
    await vi.advanceTimersByTimeAsync(6000); await backgroundGrace;
    expect(current.end).not.toHaveBeenCalled();
  });
  it('registers an idle grace after failures without ending the reusable pool', async () => {
    const current = pool(); current.unsafe.mockRejectedValueOnce(new Error('read failed')); mocks.postgres.mockReturnValue(current);
    await expect(catalogDatabase().query('SELECT 1')).rejects.toThrow('read failed');
    const grace = callbacks.shift()!(); await vi.advanceTimersByTimeAsync(6000); await grace;
    await catalogDatabase().query('SELECT 2');
    expect(current.end).not.toHaveBeenCalled();
    expect(mocks.postgres).toHaveBeenCalledOnce();
  });
  it('retains the normal reusable pool for local scripts', async () => {
    vi.stubEnv('VERCEL', ''); const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1'); expect(mocks.after).not.toHaveBeenCalled(); expect(current.end).not.toHaveBeenCalled();
  });
});
