import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { CatalogUser } from '@/lib/catalog';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { hashAccountPassword, verifyAccountPassword } from './passwords';

export class CatalogHttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const CATALOG_COOKIE = 'catalog_session';
// The workspace that already carries the WPS delivery keeps this fixed identity.
export const INTERNAL_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const SESSION_SECONDS = 60 * 60 * 24 * 30;
export function workspaceOpenAccess() {
  if (process.env.CATALOG_AUTH_MODE !== 'open') return false;
  // Open mode returns one shared account for every visitor, which defeats every tenant check
  // layered above it. Local development only.
  if (process.env.NODE_ENV === 'production') throw new Error('生产环境禁止 CATALOG_AUTH_MODE=open');
  return true;
}
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function createCatalogUser(email: string, name: string, password: string, role: CatalogUser['role'] = 'editor', tenantId = INTERNAL_TENANT_ID) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) throw new Error(`邮箱格式无效：${email}`);
  if (!name.trim() || name.length > 100) throw new Error(`姓名长度无效：${name.length}`);
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error(`角色无效：${role}`);
  const id = randomUUID();
  await catalogTransaction(async client => {
    await client.query('INSERT INTO users(id,email,display_name,password_hash,role,tenant_id) VALUES($1,$2,$3,$4,$5,$6)', [id, normalizedEmail, name.trim(), await hashAccountPassword(password), role, tenantId]);
    // Credentials live in user_identities so adding phone or social login needs no schema change.
    await client.query('INSERT INTO user_identities(id,user_id,kind,identifier,verified_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), id, 'email', normalizedEmail]);
  });
  return id;
}
/** Issue a session row for an already-authenticated user. Shared with phone sign-in. */
export async function createSession(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, userId: string) {
  const token = randomBytes(32).toString('hex');
  await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3*interval '1 second')", [tokenHash(token), userId, SESSION_SECONDS]);
  return token;
}
export async function loginCatalog(email: string, password: string) {
  if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 256) throw new CatalogHttpError(400, '邮箱或密码格式无效');
  const result = await catalogTransaction(async client => {
    const found = await client.query(`SELECT u.*, t.disabled AS tenant_disabled FROM users u
      JOIN user_identities i ON i.user_id=u.id AND i.kind='email'
      LEFT JOIN tenants t ON t.id=u.tenant_id
      WHERE i.identifier=$1 FOR UPDATE OF u`, [email.trim().toLowerCase()]);
    const user = found.rows[0];
    if (!user) { await hashAccountPassword(password.padEnd(8, ' ').slice(0, 256)); return null; }
    if (user.disabled || user.tenant_disabled || (user.locked_until && new Date(user.locked_until).getTime() > Date.now())) return null;
    // Verification-code accounts have no password and cannot sign in through this path.
    if (!user.password_hash || !await verifyAccountPassword(password, user.password_hash)) {
      await client.query("UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins >= 4 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1", [user.id]);
      return null;
    }
    await client.query('UPDATE users SET failed_logins=0,locked_until=NULL WHERE id=$1', [user.id]);
    const token = randomBytes(32).toString('hex');
    await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3*interval '1 second')", [tokenHash(token), user.id, SESSION_SECONDS]);
    return { token, user: { id: user.id, displayName: user.display_name, email: user.email, role: user.role } as CatalogUser };
  });
  if (!result) throw new CatalogHttpError(401, '登录失败；请检查密码，连续失败后需等待 15 分钟');
  return result;
}
export async function loginWorkspace(password: string) {
  const email = process.env.CATALOG_LOGIN_EMAIL?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CatalogHttpError(503, '工作台登录尚未配置，请设置 CATALOG_LOGIN_EMAIL');
  }
  if (typeof password !== 'string' || !password.length || password.length > 256) throw new CatalogHttpError(400, '密码格式无效');
  return loginCatalog(email, password);
}
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const expected = process.env.CATALOG_APP_ORIGIN || `${url.protocol}//${request.headers.get('host') || url.host}`;
  const currentOrigin = `${url.protocol}//${request.headers.get('host') || url.host}`;
  const localDevelopment = process.env.NODE_ENV === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && origin === currentOrigin;
  if (!origin || (origin !== expected && !localDevelopment)) throw new CatalogHttpError(403, '请求来源不匹配');
}
function sessionToken(request: NextRequest) {
  const token = request.cookies.get(CATALOG_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) throw new CatalogHttpError(401, '请先登录工作台');
  return token;
}
export async function catalogUser(request: NextRequest, write = false): Promise<CatalogUser> {
  if (write) assertSameOrigin(request);
  if (workspaceOpenAccess()) {
    const email = process.env.CATALOG_LOGIN_EMAIL?.trim().toLowerCase();
    if (!email) throw new CatalogHttpError(503, '工作台账号尚未配置，请设置 CATALOG_LOGIN_EMAIL');
    // Keep a real identity for existing ownership, confirmation and audit foreign keys.
    // Password lockouts do not apply to this explicitly configured shared workspace.
    const found = await catalogDatabase().query(`SELECT u.id,u.email,u.display_name,u.role FROM users u
      LEFT JOIN tenants t ON t.id=u.tenant_id
      WHERE u.email=$1 AND NOT u.disabled AND COALESCE(t.disabled,false)=false`, [email]);
    const row = found.rows[0];
    if (!row) throw new CatalogHttpError(503, '工作台账号不存在或已停用');
    if (write && row.role === 'viewer') throw new CatalogHttpError(403, '当前账号只有查看权限');
    return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
  }
  const token = sessionToken(request);
  const found = await catalogDatabase().query(`SELECT u.id,u.email,u.display_name,u.role FROM sessions s
    JOIN users u ON u.id=s.user_id
    LEFT JOIN tenants t ON t.id=u.tenant_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND COALESCE(t.disabled,false)=false`, [tokenHash(token)]);
  if (!found.rowCount) throw new CatalogHttpError(401, '登录已过期，请重新登录');
  const row = found.rows[0];
  if (write && row.role === 'viewer') throw new CatalogHttpError(403, '当前账号只有查看权限');
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
}
export async function logoutCatalog(request: NextRequest) {
  assertSameOrigin(request);
  const token = request.cookies.get(CATALOG_COOKIE)?.value;
  if (token) await catalogDatabase().query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
}
