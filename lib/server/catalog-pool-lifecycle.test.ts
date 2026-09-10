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
  it('reuses a busy pool and reclaims it only after the latest operation has been idle', async () => {
    const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1');
    let settled = false;
    const grace = callbacks.shift()!().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    await catalogDatabase().query('SELECT 2');
    expect(mocks.postgres).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(current.end).not.toHaveBeenCalled();
    const joined = callbacks.shift()!();
    await vi.advanceTimersByTimeAsync(5000); await Promise.all([grace, joined]);
    expect(current.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
    expect(mocks.postgres.mock.calls[0][1]).toMatchObject({ max: 5, idle_timeout: 5, connection: { idle_session_timeout: 60000 } });
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
    expect(current.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
  it('reclaims failed connections and creates a usable replacement', async () => {
    const current = pool(); current.unsafe.mockRejectedValueOnce(new Error('read failed')); mocks.postgres.mockReturnValue(current);
    await expect(catalogDatabase().query('SELECT 1')).rejects.toThrow('read failed');
    const grace = callbacks.shift()!(); await vi.advanceTimersByTimeAsync(6000); await grace;
    const replacement = pool(); mocks.postgres.mockReturnValue(replacement);
    await catalogDatabase().query('SELECT 2');
    expect(current.end).toHaveBeenCalledOnce();
    expect(replacement.unsafe).toHaveBeenCalledWith('SELECT 2', []);
    expect(mocks.postgres).toHaveBeenCalledTimes(2);
  });
  it('shares one pool across separately loaded route modules', async () => {
    const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1');
    vi.resetModules();
    const secondRoute = await import('./catalog-database');
    await secondRoute.catalogDatabase().query('SELECT 2');
    expect(mocks.postgres).toHaveBeenCalledOnce();
    expect(current.unsafe).toHaveBeenCalledTimes(2);
  });
  it('detaches before closing so a new request and stale cleanup never use the ending pool', async () => {
    const current = pool(), replacement = pool(); mocks.postgres.mockReturnValueOnce(current).mockReturnValue(replacement);
    let finish!: () => void;
    current.end.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await catalogDatabase().query('SELECT 1');
    const staleCallback = callbacks[0];
    const cleanup = callbacks.shift()!();
    await vi.advanceTimersByTimeAsync(6000);
    await catalogDatabase().query('SELECT 2');
    const staleCleanup = staleCallback();
    expect(replacement.unsafe).toHaveBeenCalledWith('SELECT 2', []);
    expect(replacement.end).not.toHaveBeenCalled();
    finish(); await Promise.all([cleanup, staleCleanup]);
    await staleCallback();
    expect(replacement.end).not.toHaveBeenCalled();
  });
  it('keeps a slow queued query alive and reclaims after it finishes', async () => {
    const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1');
    const cleanup = callbacks.shift()!();
    let finish!: () => void;
    current.unsafe.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); }));
    const slow = catalogDatabase().query('SELECT 2');
    await vi.advanceTimersByTimeAsync(6000); await cleanup;
    expect(current.end).not.toHaveBeenCalled();
    finish(); await slow;
    const lastCleanup = callbacks.shift()!();
    await vi.advanceTimersByTimeAsync(6000); await lastCleanup;
    expect(current.end).toHaveBeenCalledOnce();
  });
  it('retains the normal reusable pool for local scripts', async () => {
    vi.stubEnv('VERCEL', ''); const current = pool(); mocks.postgres.mockReturnValue(current);
    await catalogDatabase().query('SELECT 1'); expect(mocks.after).not.toHaveBeenCalled(); expect(current.end).not.toHaveBeenCalled();
  });
});
