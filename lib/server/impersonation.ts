import { randomBytes, randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { adminScope } from './admin-guard';
import { assertSameOrigin, CATALOG_COOKIE, CatalogHttpError, SESSION_SECONDS, tokenHash } from './catalog-auth';
import { catalogDatabase, catalogTransaction } from './catalog-database';

/**
 * An administrator "entering" another account gets an ordinary session for that account,
 * while their own session token waits in a second cookie for the way back. The cookie also
 * carries the hash of the session it was issued with, so it only counts while that exact
 * session is the current one: a later sign-in as somebody else ignores a stale cookie.
 */
export const ADMIN_RETURN_COOKIE = 'catalog_admin_return';
const IMPERSONATION_SECONDS = 12 * 60 * 60;
const HEX64 = /^[0-9a-f]{64}$/u;

type Behind = { id: string; displayName: string; token: string };

async function adminBehind(request: NextRequest): Promise<Behind | null> {
  const [adminToken, sessionHash] = request.cookies.get(ADMIN_RETURN_COOKIE)?.value.split('.') ?? [];
  const current = request.cookies.get(CATALOG_COOKIE)?.value;
  if (!adminToken || !HEX64.test(adminToken) || !current || !HEX64.test(current) || sessionHash !== tokenHash(current)) return null;
  const found = await catalogDatabase().query(`SELECT u.id, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND u.role='admin'`, [tokenHash(adminToken)]);
  const row = found.rows[0];
  return row ? { id: row.id, displayName: row.display_name, token: adminToken } : null;
}

/** The administrator behind the current session, when it is an entered account. */
export async function impersonator(request: NextRequest) {
  const behind = await adminBehind(request);
  return behind ? { displayName: behind.displayName } : null;
}

export async function startImpersonation(request: NextRequest, targetId: string) {
  const { user: admin } = await adminScope(request, true);
  if (await adminBehind(request)) throw new CatalogHttpError(400, '你已经在别的账号里了，请先返回管理员账号');
  if (targetId === admin.id) throw new CatalogHttpError(400, '这就是你自己的账号');
  const adminToken = request.cookies.get(CATALOG_COOKIE)?.value;
  if (!adminToken || !HEX64.test(adminToken)) throw new CatalogHttpError(401, '请先登录工作台');
  const token = randomBytes(32).toString('hex');
  await catalogTransaction(async client => {
    const found = await client.query(`SELECT u.id, u.email, u.disabled, COALESCE(t.disabled,false) AS tenant_disabled
      FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1`, [targetId]);
    const target = found.rows[0];
    if (!target) throw new CatalogHttpError(404, '账号不存在');
    if (target.disabled || target.tenant_disabled) throw new CatalogHttpError(400, '这个账号已停用，先启用才能进入');
    await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3*interval '1 second')", [tokenHash(token), targetId, IMPERSONATION_SECONDS]);
    await client.query('INSERT INTO audit_events(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), admin.id, 'admin.impersonate', targetId, { email: target.email }]);
  });
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(CATALOG_COOKIE, token, cookieOptions(IMPERSONATION_SECONDS));
  response.cookies.set(ADMIN_RETURN_COOKIE, `${adminToken}.${tokenHash(token)}`, cookieOptions(IMPERSONATION_SECONDS));
  return response;
}

export async function endImpersonation(request: NextRequest) {
  assertSameOrigin(request);
  const behind = await adminBehind(request);
  if (!behind) throw new CatalogHttpError(401, '管理员登录已失效，请重新登录');
  const current = request.cookies.get(CATALOG_COOKIE)!.value;
  const ended = await catalogDatabase().query('DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id', [tokenHash(current)]);
  if (ended.rows[0]) {
    await catalogDatabase().query('INSERT INTO audit_events(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), behind.id, 'admin.impersonate.end', ended.rows[0].user_id, {}]);
  }
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(CATALOG_COOKIE, behind.token, cookieOptions(SESSION_SECONDS));
  clearAdminReturn(response);
  return response;
}

/** Signing out of an entered account signs the administrator out as well. */
export async function revokeAdminBehind(request: NextRequest) {
  const behind = await adminBehind(request);
  if (behind) await catalogDatabase().query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(behind.token)]);
}

export function clearAdminReturn(response: NextResponse) {
  response.cookies.set(ADMIN_RETURN_COOKIE, '', cookieOptions(0));
}

function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge };
}
