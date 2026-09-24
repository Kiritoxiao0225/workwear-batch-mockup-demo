import { NextResponse, type NextRequest } from 'next/server';

// Paths retired with the old WPS workflow, including already-open/cached browser clients.
const RETIRED = [
  '/api/wps-production/', '/api/wps-tasks/',
  '/wps-production/legacy', '/wps-production/overview', '/task-review',
];

// Reachable without a session: the sign-in screen and the endpoints it calls.
const PUBLIC = ['/login', '/api/auth/'];

const isRetired = (pathname: string) => RETIRED.some(prefix => pathname === prefix.replace(/\/$/u, '') || pathname.startsWith(prefix));
const isPublic = (pathname: string) => PUBLIC.some(prefix => pathname === prefix.replace(/\/$/u, '') || pathname.startsWith(prefix));

/**
 * Coarse gate only. The cookie value is a random token whose hash lives in the database, so
 * it cannot be validated offline — every API and data path still verifies the session, the
 * user and the tenant. This layer exists to send signed-out visitors to the sign-in screen
 * instead of letting them load an app shell that will fail every request.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isRetired(pathname)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: '旧版工作台已停用，请使用新版批量效果图', code: 'LEGACY_WPS_RETIRED' },
        { status: 410, headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.redirect(new URL('/wps-production', request.url));
  }

  if (pathname === '/api/health' || isPublic(pathname)) return NextResponse.next();

  // The shared-workspace mode deliberately has no sign-in step; it must keep working as-is.
  if (process.env.CATALOG_AUTH_MODE === 'open') return NextResponse.next();

  const token = request.cookies.get('catalog_session')?.value;
  if (token && /^[0-9a-f]{64}$/u.test(token)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '请先登录' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const login = new URL('/login', request.url);
  login.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next internals, static assets and the standalone HTML prototypes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|saas-prototype|.*\\.(?:png|jpg|jpeg|webp|svg|css|js|mjs|txt|html|woff2?)$).*)'],
};
