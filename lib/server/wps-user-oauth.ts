import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WPS_AUTH_ENDPOINT = 'https://openapi.wps.cn/oauth2/auth';
const WPS_TOKEN_ENDPOINT = 'https://openapi.wps.cn/oauth2/token';
export const WPS_USER_SCOPES = [
  'kso.dbsheet.read',
  'kso.dbsheet.readwrite',
  'kso.file.read',
  'kso.file_link.readwrite',
] as const;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const TOKEN_FILE = path.join(process.cwd(), 'data', 'wps-user-oauth.json');

type WpsUserToken = {
  version: 2;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  updatedAt: string;
};

type WpsTokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
};

let refreshInFlight: Promise<string> | null = null;

function requiredEnvironment(name: 'WPS_APP_ID' | 'WPS_APP_KEY') {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`WPS_SYNC_NOT_CONFIGURED: 缺少 ${name}`);
  return value;
}

function positiveSeconds(value: unknown, label: string) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`WPS token 响应中的 ${label} 无效：${String(value)}`);
  }
  return number;
}

function tokenResponse(value: unknown): WpsTokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WPS token 返回了无效 JSON 对象');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error(`WPS token 响应缺少 access_token：${String(body.msg ?? '未返回错误信息')}`);
  }
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
    throw new Error('WPS token 响应缺少 refresh_token');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: positiveSeconds(body.expires_in, 'expires_in'),
    refreshExpiresIn: positiveSeconds(body.refresh_expires_in, 'refresh_expires_in'),
  };
}

function storedToken(value: unknown): WpsUserToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WPS 用户授权文件必须是对象');
  }
  const body = value as Record<string, unknown>;
  if (body.version !== 2) throw new Error(`WPS 用户授权文件版本无效：${String(body.version)}`);
  if (!Array.isArray(body.scopes) || body.scopes.some((scope) => typeof scope !== 'string')) {
    throw new Error('WPS 用户授权文件缺少 scopes');
  }
  const missingScope = WPS_USER_SCOPES.find((scope) => !(body.scopes as string[]).includes(scope));
  if (missingScope) throw new Error(`WPS_USER_AUTH_REQUIRED: WPS 用户授权缺少 ${missingScope}，请重新连接 WPS`);
  for (const key of ['accessToken', 'refreshToken', 'updatedAt'] as const) {
    if (typeof body[key] !== 'string' || !body[key]) throw new Error(`WPS 用户授权文件缺少 ${key}`);
  }
  for (const key of ['accessExpiresAt', 'refreshExpiresAt'] as const) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
      throw new Error(`WPS 用户授权文件中的 ${key} 无效：${String(body[key])}`);
    }
  }
  return body as WpsUserToken;
}

async function readStoredToken() {
  try {
    const value = JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).version !== 2) {
      return null;
    }
    return storedToken(value);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeStoredToken(response: WpsTokenResponse) {
  const now = Date.now();
  const token: WpsUserToken = {
    version: 2,
    scopes: [...WPS_USER_SCOPES],
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    accessExpiresAt: now + response.expiresIn * 1_000,
    refreshExpiresAt: now + response.refreshExpiresIn * 1_000,
    updatedAt: new Date(now).toISOString(),
  };
  await mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  const pendingTokenPath = `${TOKEN_FILE}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pendingTokenPath, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pendingTokenPath, TOKEN_FILE);
  return token;
}

async function requestToken(parameters: URLSearchParams) {
  const response = await fetch(WPS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: parameters,
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`WPS token 返回了无效 JSON：HTTP ${response.status}`);
  }
  if (!response.ok || (body && typeof body === 'object' && 'code' in body && body.code !== 0)) {
    const message = body && typeof body === 'object' && 'msg' in body ? String(body.msg) : '未返回错误信息';
    throw new Error(`WPS 用户授权失败：HTTP ${response.status} · ${message}`);
  }
  return tokenResponse(body);
}

export function wpsOAuthConfigurationStatus() {
  const missing = (['WPS_APP_ID', 'WPS_APP_KEY'] as const).filter((name) => !process.env[name]?.trim());
  return { configured: missing.length === 0, missing };
}

export function wpsOAuthRedirectUri(origin: string) {
  return process.env.WPS_OAUTH_REDIRECT_URI?.trim() || `${origin}/api/wps/oauth/callback`;
}

export function wpsAuthorizationUrl(redirectUri: string, state: string) {
  if (!state) throw new Error('WPS OAuth state 不能为空');
  const url = new URL(WPS_AUTH_ENDPOINT);
  url.searchParams.set('client_id', requiredEnvironment('WPS_APP_ID'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', WPS_USER_SCOPES.join(','));
  url.searchParams.set('state', state);
  return url;
}

export async function completeWpsUserAuthorization(code: string, redirectUri: string) {
  if (!code) throw new Error('WPS OAuth 回调缺少 code');
  const response = await requestToken(new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: requiredEnvironment('WPS_APP_ID'),
    client_secret: requiredEnvironment('WPS_APP_KEY'),
    code,
    redirect_uri: redirectUri,
  }));
  await writeStoredToken(response);
}

async function refreshWpsUserAccessToken(token: WpsUserToken) {
  if (Date.now() >= token.refreshExpiresAt) {
    throw new Error('WPS_USER_AUTH_REQUIRED: WPS 用户授权已超过有效期，请重新连接 WPS 账号');
  }
  const response = await requestToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: requiredEnvironment('WPS_APP_ID'),
    client_secret: requiredEnvironment('WPS_APP_KEY'),
  }));
  return (await writeStoredToken(response)).accessToken;
}

export async function wpsUserAccessToken() {
  const token = await readStoredToken();
  if (!token) {
    throw new Error('WPS_USER_AUTH_REQUIRED: 尚未连接有该表访问权限的 WPS 账号');
  }
  if (Date.now() + TOKEN_REFRESH_MARGIN_MS < token.accessExpiresAt) return token.accessToken;
  refreshInFlight ??= refreshWpsUserAccessToken(token).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function wpsUserAuthorizationStatus() {
  let token: WpsUserToken | null;
  try { token = await readStoredToken(); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('WPS_USER_AUTH_REQUIRED:')) throw error;
    return { authorized: false, accessExpiresAt: null, refreshExpiresAt: null, reason: error.message };
  }
  return {
    authorized: Boolean(token && Date.now() < token.refreshExpiresAt),
    accessExpiresAt: token?.accessExpiresAt ?? null,
    refreshExpiresAt: token?.refreshExpiresAt ?? null,
  };
}
