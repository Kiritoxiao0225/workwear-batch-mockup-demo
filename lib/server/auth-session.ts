import { NextResponse } from 'next/server';
import type { CatalogUser } from '@/lib/catalog';
import { CATALOG_COOKIE, SESSION_SECONDS } from './catalog-auth';
import { clearAdminReturn } from './impersonation';

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

export function clearedSessionResponse(body: Record<string, unknown> = { ok: true }, status = 200) {
  const response = NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(CATALOG_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  clearAdminReturn(response);
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

/**
 * The client address as Zeabur's edge saw it. The edge appends that address to X-Forwarded-For, so
 * only the last hop can be trusted; anything before it is whatever the client chose to send
 * (checked on 2026-10-16: a spoofed header arrived as two public hops and no X-Real-IP).
 */
export function requestIp(request: Request) {
  const last = request.headers.get('x-forwarded-for')?.split(',').map(hop => hop.trim()).filter(Boolean).at(-1);
  if (last && /^[0-9a-fA-F:.]{3,45}$/u.test(last)) return last;
  return null;
}
