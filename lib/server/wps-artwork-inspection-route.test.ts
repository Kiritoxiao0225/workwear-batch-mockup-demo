import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/wps-production/artwork-inspection/route';
import { readWpsProductionState } from './wps-production-store';
import { catalogDatabase } from './catalog-database';

vi.mock('./wps-production-store', () => ({ readWpsProductionState: vi.fn() }));
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('WPS_PRODUCTION_STORAGE', 'cloud');
  vi.stubEnv('CATALOG_APP_ORIGIN', 'http://localhost:3000');
  vi.mocked(readWpsProductionState).mockResolvedValue({ units: [] } as unknown as Awaited<ReturnType<typeof readWpsProductionState>>);
});
afterEach(() => vi.unstubAllEnvs());

describe('browser artwork inspection', () => {
  const request = (origin?: string) => new Request('http://localhost:3000/api/wps-production/artwork-inspection?unitId=test&sizing=true', { method: 'POST', headers: { ...(origin ? { Origin: origin } : {}), Cookie: `catalog_session=${'a'.repeat(64)}` } });
  const user = (role: string) => vi.mocked(catalogDatabase).mockReturnValue({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'editor', display_name: '测试', email: 'test@example.com', role }] }) } as unknown as ReturnType<typeof catalogDatabase>);

  it('accepts the browser POST from the current origin for a signed-in editor', async () => {
    user('editor');
    expect((await POST(request('http://localhost:3000'))).status).toBe(404);
    expect(readWpsProductionState).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'https://unrelated.example'])('retains the origin guard for %s', async origin => {
    user('editor');
    const response = await POST(request(origin));
    expect((await response.json()).error).toBe('请求来源不匹配');
    expect(readWpsProductionState).not.toHaveBeenCalled();
  });
  it('retains editor permissions and rejects viewer inspection', async () => {
    user('viewer');
    const response = await POST(request('http://localhost:3000'));
    expect(response.ok).toBe(false);
    expect(readWpsProductionState).not.toHaveBeenCalled();
  });
});
