import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { CatalogUser } from '@/lib/catalog';
import { catalogDatabase, catalogTransaction } from './catalog-database';

export class CatalogHttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const CATALOG_COOKIE = 'catalog_session';
export const SESSION_SECONDS = 60 * 60 * 24 * 30;
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
function passwordHash(password: string) {
  if (password.length < 8 || password.length > 256) throw new Error('密码长度必须在 8 到 256 字符之间');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password: string, encoded: string) {
  const [salt, hash] = encoded.split(':');
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
export async function createCatalogUser(email: string, name: string, password: string, role: CatalogUser['role'] = 'editor') {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) throw new Error(`邮箱格式无效：${email}`);
  if (!name.trim() || name.length > 100) throw new Error(`姓名长度无效：${name.length}`);
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error(`角色无效：${role}`);
  const id = randomUUID();
  await catalogDatabase().query('INSERT INTO users(id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)', [id, normalizedEmail, name.trim(), passwordHash(password), role]);
  return id;
}
export async function loginCatalog(email: string, password: string) {
  if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 256) throw new CatalogHttpError(400, '邮箱或密码格式无效');
  const result = await catalogTransaction(async client => {
    const found = await client.query('SELECT * FROM users WHERE email=$1 FOR UPDATE', [email.trim().toLowerCase()]);
    const user = found.rows[0];
    if (!user) { scryptSync(password, 'catalog-missing-user', 64); return null; }
    if (user.disabled || (user.locked_until && new Date(user.locked_until).getTime() > Date.now())) return null;
    if (!passwordMatches(password, user.password_hash)) {
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
  const token = sessionToken(request);
  const found = await catalogDatabase().query('SELECT u.id,u.email,u.display_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled', [tokenHash(token)]);
  if (!found.rowCount) throw new CatalogHttpError(401, '登录已过期，请重新登录');
  const row = found.rows[0];
  if (write && row.role === 'viewer') throw new CatalogHttpError(403, '当前账号只有查看权限');
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
}
export async function renewCatalogSession(request: NextRequest) {
  assertSameOrigin(request);
  const token = sessionToken(request);
  const found = await catalogDatabase().query(`UPDATE sessions s SET expires_at=now()+$2*interval '1 second'
    FROM users u WHERE s.user_id=u.id AND s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled
    RETURNING u.id,u.email,u.display_name,u.role`, [tokenHash(token), SESSION_SECONDS]);
  if (!found.rowCount) throw new CatalogHttpError(401, '登录已过期，请重新登录');
  const row = found.rows[0];
  const user: CatalogUser = { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
  return { token, user };
}
export async function logoutCatalog(request: NextRequest) {
  assertSameOrigin(request);
  const token = request.cookies.get(CATALOG_COOKIE)?.value;
  if (token) await catalogDatabase().query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
}
