import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, catalogUser, CatalogHttpError, CATALOG_COOKIE, loginWorkspace, logoutCatalog, workspaceOpenAccess } from '@/lib/server/catalog-auth';
import type { CatalogUser } from '@/lib/catalog';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { revokeAdminBehind } from '@/lib/server/impersonation';
import { limitPasswordLogin } from '@/lib/server/password-login-limit';
import { clearedSessionResponse, requestIp, sessionResponse as authenticatedResponse } from '@/lib/server/auth-session';
export const dynamic = 'force-dynamic';
function sessionResponse(result: { user: CatalogUser; token?: string }) {
  const body = { user: result.user, localStorage: Boolean(process.env.CATALOG_LOCAL_OBJECT_ROOT) };
  return result.token ? authenticatedResponse(body, result.token) : NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
function sessionError(error: unknown) {
  // A missing/revoked session cannot recover by retrying the same cookie. Preserve real
  // server/network failures so they neither erase credentials nor sign the user out.
  return error instanceof CatalogHttpError && error.status === 401
    ? clearedSessionResponse({ error: error.message }, 401) : catalogError(error);
}
export async function GET(request: NextRequest) { try { return sessionResponse({ user: await catalogUser(request), token: workspaceOpenAccess() ? undefined : request.cookies.get(CATALOG_COOKIE)?.value }); } catch (error) { return sessionError(error); } }
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    if (workspaceOpenAccess()) return GET(request);
    const input = z.object({ password: z.string().min(1).max(256) }).strict().parse(await catalogJson(request));
    await limitPasswordLogin(requestIp(request));
    return sessionResponse(await loginWorkspace(input.password));
  } catch (error) { return catalogError(error); }
}
// Old clients still send PATCH. It reads the session like GET and never extends it: an extension
// would turn a 12-hour 进入账号 session into a 30-day one.
export async function PATCH(request: NextRequest) {
  try { assertSameOrigin(request); return await GET(request); }
  catch (error) { return catalogError(error); }
}
export async function DELETE(request: NextRequest) {
  try { assertSameOrigin(request); await revokeAdminBehind(request); await logoutCatalog(request); return clearedSessionResponse(); }
  catch (error) { return catalogError(error); }
}
