import { NextResponse } from 'next/server';

import { wpsOAuthConfigurationStatus, wpsUserAuthorizationStatus } from '@/lib/server/wps-user-oauth';

export const runtime = 'nodejs';

export async function GET() {
  const configuration = wpsOAuthConfigurationStatus();
  if (!configuration.configured) {
    return NextResponse.json({ configured: false, authorized: false, missingEnvironment: configuration.missing });
  }
  return NextResponse.json({ configured: true, missingEnvironment: [], ...await wpsUserAuthorizationStatus() });
}
