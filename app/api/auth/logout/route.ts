import { NextRequest } from 'next/server';
import { logoutCatalog } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';
import { clearedSessionResponse } from '@/lib/server/auth-session';
import { revokeAdminBehind } from '@/lib/server/impersonation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    await revokeAdminBehind(request);
    await logoutCatalog(request);
    return clearedSessionResponse();
  } catch (error) { return catalogError(error); }
}
