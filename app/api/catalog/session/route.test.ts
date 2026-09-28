import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { limitPasswordLogin } from '@/lib/server/password-login-limit';
vi.mock('@/lib/server/password-login-limit', () => ({ limitPasswordLogin: vi.fn() }));
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
  vi.stubEnv('CATALOG_AUTH_MODE', 'password');
  vi.clearAllMocks(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('CATALOG_APP_ORIGIN', 'https://mockup.example');
  vi.mocked(limitPasswordLogin).mockResolvedValue(undefined);
  vi.mocked(loginWorkspace).mockResolvedValue({ user, token });
  vi.mocked(renewCatalogSession).mockResolvedValue({ user, token });
  vi.mocked(catalogUser).mockResolvedValue(user);
});
afterEach(() => vi.unstubAllEnvs());
describe('persistent project sessions', () => {
  it('rejects the shared workspace mode in production, where it would bypass every tenant check', async () => {
    vi.stubEnv('CATALOG_AUTH_MODE', 'open');
    vi.stubEnv('NODE_ENV', 'production');
    expect((await GET(request('GET'))).status).toBe(500);
  });
  it('opens a shared workspace without credentials or session cookies, including old clients using PATCH', async () => {
    vi.stubEnv('CATALOG_AUTH_MODE', 'open');
    // Shared access is a local-development convenience; production refuses it outright.
    vi.stubEnv('NODE_ENV', 'development');
    for (const [method, handler] of [['GET', GET], ['PATCH', PATCH], ['POST', POST]] as const) {
      const response = await handler(new NextRequest('https://mockup.example/api/catalog/session', { method, headers: { origin: 'https://mockup.example' } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ user, localStorage: false });
      expect(response.headers.has('set-cookie')).toBe(false);
    }
    expect(loginWorkspace).not.toHaveBeenCalled();
    expect(renewCatalogSession).not.toHaveBeenCalled();
  });
  it('sets the same protected 30-day cookie on login and renewal without exposing the token in JSON', async () => {
    const responses = [await POST(request('POST', { password: 'example-password' })), await PATCH(request('PATCH'))];
    expect(loginWorkspace).toHaveBeenCalledExactlyOnceWith('example-password');
    for (const response of responses) {
      expect(response.status).toBe(200);
      const cookie = response.cookies.get('catalog_session');
      expect(cookie).toMatchObject({ value: token, path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 });
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
  it('rate limits legacy password entry before checking credentials', async () => {
    vi.mocked(limitPasswordLogin).mockRejectedValueOnce(new CatalogHttpError(429, '登录尝试过于频繁'));
    expect((await POST(request('POST', { password: 'example-password' }))).status).toBe(429);
    expect(loginWorkspace).not.toHaveBeenCalled();
  });
  it('rejects cross-origin login before password validation', async () => {
    const response = await POST(new NextRequest('https://mockup.example/api/catalog/session', { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'example-password' }) }));
    expect(response.status).toBe(403);
    expect(loginWorkspace).not.toHaveBeenCalled();
    expect(response.headers.has('set-cookie')).toBe(false);
  });
  it('clears every historical cookie path when the session is expired or revoked', async () => {
    vi.mocked(renewCatalogSession).mockRejectedValue(new CatalogHttpError(401, '登录已过期，请重新登录'));
    const response = await PATCH(request('PATCH'));
    expect(response.status).toBe(401);
    expect(response.cookies.get('catalog_session')).toMatchObject({ value: '', path: '/', maxAge: 0 });
    for (const path of ['/api', '/api/catalog']) expect(response.headers.getSetCookie().some(value => value.includes(`Path=${path};`) && value.includes('Max-Age=0'))).toBe(true);
  });
  it('clears a lost session on GET but preserves credentials on permission and server failures', async () => {
    vi.mocked(catalogUser).mockRejectedValueOnce(new CatalogHttpError(401, '登录已过期，请重新登录'));
    const expired = await GET(request('GET'));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: '登录已过期，请重新登录' });
    expect(expired.cookies.get('catalog_session')).toMatchObject({ value: '', path: '/', maxAge: 0 });
    for (const status of [403, 500, 503]) {
      vi.mocked(catalogUser).mockRejectedValueOnce(new CatalogHttpError(status, '暂时无法连接'));
      const failed = await GET(request('GET'));
      expect(failed.status).toBe(status);
      expect(failed.headers.has('set-cookie')).toBe(false);
    }
  });
  it('upgrades to a root cookie without renewing GET and clears all paths on logout', async () => {
    expect((await GET(request('GET'))).cookies.get('catalog_session')).toMatchObject({ value: token, path: '/' });
    expect(renewCatalogSession).not.toHaveBeenCalled();
    const response = await DELETE(request('DELETE'));
    expect(logoutCatalog).toHaveBeenCalledOnce();
    expect(response.cookies.get('catalog_session')).toMatchObject({ value: '', path: '/', maxAge: 0 });
    expect(response.headers.getSetCookie().some(value => value.includes('Path=/api/catalog;') && value.includes('Max-Age=0'))).toBe(true);
  });
});
