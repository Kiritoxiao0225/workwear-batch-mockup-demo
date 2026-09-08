import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/wps-production/cutout/route';
import { catalogDatabase } from './catalog-database';
import { startArtworkCutout, queryArtworkCutout } from './artwork-cutout';
import { assertCutoutStoreReady } from './artwork-cutout-store';
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));
vi.mock('./artwork-cutout', () => ({ startArtworkCutout: vi.fn(), queryArtworkCutout: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('WPS_PRODUCTION_STORAGE', 'cloud'); vi.stubEnv('CATALOG_APP_ORIGIN', 'http://localhost:3000'); });
afterEach(() => vi.unstubAllEnvs());
const query = vi.fn();
function role(value: string) { query.mockResolvedValue({ rowCount: 1, rows: [{ id: 'editor', display_name: '测试', email: 'test@example.com', role: value }] }); vi.mocked(catalogDatabase).mockReturnValue({ query } as unknown as ReturnType<typeof catalogDatabase>); }
const request = (body: unknown, origin?: string) => new Request('http://localhost:3000/api/wps-production/cutout', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), Cookie: `catalog_session=${'a'.repeat(64)}` }, body: JSON.stringify(body) });
describe('cutout API boundaries', () => {
  it('retains editor and same-origin permissions before any paid submission', async () => {
    role('editor'); expect((await POST(request({ action: 'process' }))).status).toBe(403);
    role('viewer'); expect((await POST(request({ action: 'process' }, 'http://localhost:3000'))).status).toBe(403);
    expect(startArtworkCutout).not.toHaveBeenCalled();
  });
  it('queries only the supplied job and never submits another task', async () => {
    role('editor'); vi.mocked(queryArtworkCutout).mockResolvedValue({ status: 'pending', receipt: { sourceUrl: '' } } as Awaited<ReturnType<typeof queryArtworkCutout>>);
    const response = await POST(request({ action: 'query', jobKey: 'a'.repeat(64) }, 'http://localhost:3000'));
    expect(response.status).toBe(200); expect(queryArtworkCutout).toHaveBeenCalledWith('a'.repeat(64)); expect(startArtworkCutout).not.toHaveBeenCalled();
  });
  it('gives an actionable readiness error when migration is missing', async () => {
    role('editor'); query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(assertCutoutStoreReady()).rejects.toThrow('本次尚未开始付费处理');
  });
});
