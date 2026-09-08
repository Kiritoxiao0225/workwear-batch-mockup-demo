import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import {
  wpsAuthorizationUrl,
  wpsOAuthConfigurationStatus,
  wpsOAuthRedirectUri,
} from '@/lib/server/wps-user-oauth';

export const runtime = 'nodejs';

export function GET(request: NextRequest) {
  const configuration = wpsOAuthConfigurationStatus();
  if (!configuration.configured) {
    return NextResponse.json({ error: `WPS 用户授权未配置：缺少 ${configuration.missing.join(', ')}` }, { status: 503 });
  }
  const state = randomUUID();
  const redirectUri = wpsOAuthRedirectUri(request.nextUrl.origin);
  const response = NextResponse.redirect(wpsAuthorizationUrl(redirectUri, state));
  response.cookies.set('wps_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    maxAge: 10 * 60,
    path: '/',
  });
  return response;
}
