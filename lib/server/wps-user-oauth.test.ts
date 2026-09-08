import { afterEach, describe, expect, it } from 'vitest';

import { WPS_USER_SCOPES, wpsAuthorizationUrl, wpsOAuthRedirectUri } from '@/lib/server/wps-user-oauth';

const originalAppId = process.env.WPS_APP_ID;
const originalRedirectUri = process.env.WPS_OAUTH_REDIRECT_URI;

afterEach(() => {
  if (originalAppId === undefined) delete process.env.WPS_APP_ID;
  else process.env.WPS_APP_ID = originalAppId;
  if (originalRedirectUri === undefined) delete process.env.WPS_OAUTH_REDIRECT_URI;
  else process.env.WPS_OAUTH_REDIRECT_URI = originalRedirectUri;
});

describe('WPS user OAuth', () => {
  it('builds the authorization-code URL with the real spreadsheet scopes', () => {
    process.env.WPS_APP_ID = 'test-app-id';
    const redirectUri = 'http://localhost:3001/api/wps/oauth/callback';
    const url = wpsAuthorizationUrl(redirectUri, 'state-123');

    expect(url.origin + url.pathname).toBe('https://openapi.wps.cn/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('test-app-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('scope')).toBe(WPS_USER_SCOPES.join(','));
    expect(url.searchParams.get('state')).toBe('state-123');
  });

  it('uses the configured callback verbatim', () => {
    process.env.WPS_OAUTH_REDIRECT_URI = 'https://example.com/api/wps/oauth/callback';
    expect(wpsOAuthRedirectUri('http://localhost:3001'))
      .toBe('https://example.com/api/wps/oauth/callback');
  });
});
