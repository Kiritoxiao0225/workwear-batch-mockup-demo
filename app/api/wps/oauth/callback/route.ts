import { NextRequest, NextResponse } from 'next/server';

import { completeWpsUserAuthorization, wpsOAuthRedirectUri } from '@/lib/server/wps-user-oauth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const oauthError = request.nextUrl.searchParams.get('error');
  if (oauthError) return NextResponse.json({ error: `WPS 用户拒绝或未完成授权：${oauthError}` }, { status: 400 });

  const state = request.nextUrl.searchParams.get('state') ?? '';
  const expectedState = request.cookies.get('wps_oauth_state')?.value ?? '';
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: 'WPS OAuth state 校验失败，请从项目内重新发起连接' }, { status: 400 });
  }

  try {
    await completeWpsUserAuthorization(
      request.nextUrl.searchParams.get('code') ?? '',
      wpsOAuthRedirectUri(request.nextUrl.origin),
    );
    const response = NextResponse.redirect(new URL('/wps-production?wps=connected', request.nextUrl.origin));
    response.cookies.delete('wps_oauth_state');
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
