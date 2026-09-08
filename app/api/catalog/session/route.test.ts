import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, GET, PATCH, POST } from './route';
import { CatalogHttpError, catalogUser, loginWorkspace, logoutCatalog, renewCatalogSession, SESSION_SECONDS } from '@/lib/server/catalog-auth';

vi.mock('@/lib/server/catalog-auth', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/server/catalog-auth')>();
  return { ...original, catalogUser: vi.fn(), loginWorkspace: vi.fn(), logoutCatalog: vi.fn(), renewCatalogSession: vi.fn() };
});
const user = { id: 'ebcc50c7-459a-4bf8-b41d-4385938a6d85', email: 'test@example.test', displayName: '测试', role: 'editor' as const };
const token = 'a'.repeat(64);
function request(method: string, body?: unknown) {
  return new NextRequest('https://mockup.example/api/catalog/session', { method, headers: { origin: 'https://mockup.example', cookie: `catalog_session=${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('CATALOG_APP_ORIGIN', 'https://mockup.example');
  vi.mocked(loginWorkspace).mockResolvedValue({ user, token });
  vi.mocked(renewCatalogSession).mockResolvedValue({ user, token });
  vi.mocked(catalogUser).mockResolvedValue(user);
});
afterEach(() => vi.unstubAllEnvs());
describe('persistent project sessions', () => {
  it('sets the same protected 30-day cookie on login and renewal without exposing the token in JSON', async () => {
    const responses = [await POST(request('POST', { password: 'example-password' })), await PATCH(request('PATCH'))];
    expect(loginWorkspace).toHaveBeenCalledExactlyOnceWith('example-password');
    for (const response of responses) {
      expect(response.status).toBe(200);
      const cookie = response.cookies.get('catalog_session');
      expect(cookie).toMatchObject({ value: token, path: '/api', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 });
      expect(response.headers.getSetCookie().some(value => value.includes('Path=/api/catalog;') && value.includes('Max-Age=0'))).toBe(true);
      expect(cookie?.maxAge).toBe(SESSION_SECONDS);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ user, localStorage: false });
    }
  });
  it.each([{}, { password: '' }, { password: 12345678 }, { password: 'a'.repeat(257) }, { email: user.email, password: 'example-password' }])('rejects invalid password-only requests before authentication: %j', async body => {
    const response = await POST(request('POST', body));
    expect(response.status).toBe(400);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(loginWorkspace).not.toHaveBeenCalled();
  });
  it('rejects cross-origin login before password validation', async () => {
    const response = await POST(new NextRequest('https://mockup.example/api/catalog/session', { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'example-password' }) }));
    expect(response.status).toBe(403);
    expect(loginWorkspace).not.toHaveBeenCalled();
    expect(response.headers.has('set-cookie')).toBe(false);
  });
  it('does not send a renewed cookie when the session is expired or revoked', async () => {
    vi.mocked(renewCatalogSession).mockRejectedValue(new CatalogHttpError(401, '登录已过期，请重新登录'));
    const response = await PATCH(request('PATCH'));
    expect(response.status).toBe(401);
    expect(response.headers.has('set-cookie')).toBe(false);
  });
  it('upgrades the cookie scope without renewing GET and clears both paths on logout', async () => {
    expect((await GET(request('GET'))).cookies.get('catalog_session')).toMatchObject({ value: token, path: '/api' });
    expect(renewCatalogSession).not.toHaveBeenCalled();
    const response = await DELETE(request('DELETE'));
    expect(logoutCatalog).toHaveBeenCalledOnce();
    expect(response.cookies.get('catalog_session')).toMatchObject({ value: '', path: '/api', maxAge: 0 });
    expect(response.headers.getSetCookie().some(value => value.includes('Path=/api/catalog;') && value.includes('Max-Age=0'))).toBe(true);
  });
});
