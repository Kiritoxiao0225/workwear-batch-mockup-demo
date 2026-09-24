import { internalScope } from '@/lib/server/tenant-scope';
import { NextRequest, NextResponse } from 'next/server';

import { wpsOAuthConfigurationStatus, wpsUserAuthorizationStatus } from '@/lib/server/wps-user-oauth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try { await internalScope(request); } catch { return NextResponse.json({ error: '该功能仅限内部账号' }, { status: 403 }); }
  const configuration = wpsOAuthConfigurationStatus();
  if (!configuration.configured) {
    return NextResponse.json({ configured: false, authorized: false, missingEnvironment: configuration.missing });
  }
  return NextResponse.json({ configured: true, missingEnvironment: [], ...await wpsUserAuthorizationStatus() });
}
