import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { catalogUser } from './catalog-auth';
import { catalogDatabase } from './catalog-database';

vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn(), catalogTransaction: vi.fn() }));
const query = vi.fn();
const row = { id: 'ebcc50c7-459a-4bf8-b41d-4385938a6d85', email: 'shared@example.test', display_name: '工作台', role: 'editor' };
const request = (origin = 'https://mockup.example', cookie = '') => new NextRequest('https://mockup.example/api/catalog/styles', { headers: { origin, cookie } });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CATALOG_AUTH_MODE', 'open');
  vi.stubEnv('CATALOG_LOGIN_EMAIL', ' Shared@example.test ');
  vi.stubEnv('CATALOG_APP_ORIGIN', 'https://mockup.example');
  vi.mocked(catalogDatabase).mockReturnValue({ query });
  query.mockResolvedValue({ rows: [row], rowCount: 1 });
});
afterEach(() => vi.unstubAllEnvs());
describe('shared workspace access', () => {
  it.each(['', 'catalog_session=expired'])('uses the configured real account without a valid cookie: %s', async cookie => {
    expect(await catalogUser(request(undefined, cookie), true)).toEqual({ id: row.id, email: row.email, displayName: row.display_name, role: row.role });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('AND NOT disabled'), ['shared@example.test']);
  });
  it('rejects cross-origin writes before accessing the database', async () => {
    await expect(catalogUser(request('https://foreign.example'), true)).rejects.toMatchObject({ status: 403 });
    expect(query).not.toHaveBeenCalled();
  });
  it('retains viewer read access and rejects writes', async () => {
    query.mockResolvedValue({ rows: [{ ...row, role: 'viewer' }], rowCount: 1 });
    expect((await catalogUser(request())).role).toBe('viewer');
    await expect(catalogUser(request(), true)).rejects.toMatchObject({ status: 403 });
  });
  it('fails clearly when the shared account is missing or disabled', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(catalogUser(request())).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('CATALOG_LOGIN_EMAIL', '');
    query.mockClear();
    await expect(catalogUser(request())).rejects.toMatchObject({ status: 503 });
    expect(query).not.toHaveBeenCalled();
  });
  it('requires authentication unless shared access is explicitly enabled', async () => {
    vi.stubEnv('CATALOG_AUTH_MODE', '');
    await expect(catalogUser(request())).rejects.toMatchObject({ status: 401 });
    expect(query).not.toHaveBeenCalled();
  });
});
