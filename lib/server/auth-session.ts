import { NextResponse } from 'next/server';
import type { CatalogUser } from '@/lib/catalog';
import { CATALOG_COOKIE, SESSION_SECONDS } from './catalog-auth';

/**
 * Session cookies are read by page-level guards as well as by `/api`, so the cookie lives at
 * the site root. The previous `/api`-scoped cookie is cleared explicitly: browsers keep both
 * paths otherwise and would send two values with the same name.
 */
export function sessionResponse(body: Record<string, unknown>, token: string) {
  const response = NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(CATALOG_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
  clearLegacyCookiePaths(response);
  return response;
}

export function clearedSessionResponse(body: Record<string, unknown> = { ok: true }) {
  const response = NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(CATALOG_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  clearLegacyCookiePaths(response);
  return response;
}

function clearLegacyCookiePaths(response: NextResponse) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  for (const path of ['/api', '/api/catalog']) {
    response.headers.append('Set-Cookie', `${CATALOG_COOKIE}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  }
}

export const publicUser = (user: CatalogUser) => ({
  id: user.id, email: user.email, displayName: user.displayName, role: user.role,
});

/** Trust only the proxy hop we control; an arbitrary X-Forwarded-For chain is attacker-supplied. */
export function requestIp(request: Request) {
  const header = request.headers.get('x-forwarded-for');
  const first = header?.split(',')[0]?.trim();
  if (first && /^[0-9a-fA-F:.]{3,45}$/u.test(first)) return first;
  return null;
}
