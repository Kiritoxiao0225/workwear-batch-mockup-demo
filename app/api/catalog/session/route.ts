import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, catalogUser, CATALOG_COOKIE, loginWorkspace, logoutCatalog, renewCatalogSession, SESSION_SECONDS, workspaceOpenAccess } from '@/lib/server/catalog-auth';
import type { CatalogUser } from '@/lib/catalog';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
export const dynamic = 'force-dynamic';
function sessionResponse(result: { user: CatalogUser; token?: string }) {
  const response = NextResponse.json({ user: result.user, localStorage: Boolean(process.env.CATALOG_LOCAL_OBJECT_ROOT) }, { headers: { 'Cache-Control': 'no-store' } });
  if (!result.token) return response;
  response.cookies.set(CATALOG_COOKIE, result.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api', maxAge: SESSION_SECONDS });
  response.headers.append('Set-Cookie', `${CATALOG_COOKIE}=; Path=/api/catalog; Max-Age=0; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return response;
}
export async function GET(request: NextRequest) { try { return sessionResponse({ user: await catalogUser(request), token: workspaceOpenAccess() ? undefined : request.cookies.get(CATALOG_COOKIE)?.value }); } catch (error) { return catalogError(error); } }
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    if (workspaceOpenAccess()) return GET(request);
    const input = z.object({ password: z.string().min(1).max(256) }).strict().parse(await catalogJson(request));
    return sessionResponse(await loginWorkspace(input.password));
  } catch (error) { return catalogError(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    if (workspaceOpenAccess()) { assertSameOrigin(request); return GET(request); }
    return sessionResponse(await renewCatalogSession(request));
  }
  catch (error) { return catalogError(error); }
}
export async function DELETE(request: NextRequest) {
  try { await logoutCatalog(request); const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } }); response.cookies.set(CATALOG_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api', maxAge: 0 }); response.headers.append('Set-Cookie', `${CATALOG_COOKIE}=; Path=/api/catalog; Max-Age=0; HttpOnly; SameSite=Lax`); return response; }
  catch (error) { return catalogError(error); }
}
