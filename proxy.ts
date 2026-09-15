import { NextResponse, type NextRequest } from 'next/server';

// Retire the old WPS workflow, including already-open/cached browser clients.
// New workbench and shared image/catalog endpoints are outside this matcher.
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '旧版工作台已停用，请使用新版批量效果图', code: 'LEGACY_WPS_RETIRED' },
      { status: 410, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.redirect(new URL('/wps-production', request.url));
}

export const config = {
  matcher: ['/api/wps-production/:path*', '/api/wps-tasks/:path*', '/wps-production/legacy/:path*', '/wps-production/overview/:path*', '/task-review/:path*'],
};
