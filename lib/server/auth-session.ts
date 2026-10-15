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

// Temporary (2026-10 security batch 1): how Zeabur forwards the client address decides which hop the
// rate limits can trust. Only the shape is logged, never an address; removed once requestIp is fixed.
let forwardingShapesLogged = 0;
const privateAddress = (ip: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd]|fe80:)/iu.test(ip);
function logForwardingShape(headers: Headers) {
  if (forwardingShapesLogged >= 20) return;
  forwardingShapesLogged += 1;
  const hops = (headers.get('x-forwarded-for') ?? '').split(',').map(hop => hop.trim()).filter(Boolean);
  const realIp = headers.get('x-real-ip')?.trim();
  console.info('[client-ip] shape', JSON.stringify({
    hops: hops.length, privateHops: hops.map(privateAddress),
    realIp: realIp ? (realIp === hops[0] ? 'first' : realIp === hops.at(-1) ? 'last' : 'other') : 'absent',
    headers: [...headers.keys()].filter(name => /ip|forward|real|client|via/iu.test(name)),
  }));
}

/** Trust only the proxy hop we control; an arbitrary X-Forwarded-For chain is attacker-supplied. */
export function requestIp(request: Request) {
  logForwardingShape(request.headers);
  const header = request.headers.get('x-forwarded-for');
  const first = header?.split(',')[0]?.trim();
  if (first && /^[0-9a-fA-F:.]{3,45}$/u.test(first)) return first;
  return null;
}
