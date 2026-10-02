import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { pagesFor, type AppPage } from '@/lib/app-pages';
import { CATALOG_COOKIE, CatalogHttpError, INTERNAL_TENANT_ID, tokenHash, workspaceOpenAccess } from './catalog-auth';
import { catalogDatabase } from './catalog-database';

type AccessRow = { role: string; tenant_id: string; allowed_pages: string[] | null };

const pagesOf = (row: AccessRow) =>
  pagesFor({ role: row.role, internal: row.tenant_id === INTERNAL_TENANT_ID, allowed: row.allowed_pages });

/** Pages the given account may open. */
export async function userPages(userId: string): Promise<AppPage[]> {
  const found = await catalogDatabase().query('SELECT role, tenant_id, allowed_pages FROM users WHERE id=$1', [userId]);
  if (!found.rowCount) throw new CatalogHttpError(401, '登录已过期，请重新登录');
  return pagesOf(found.rows[0] as AccessRow);
}

/** API gate: the account must hold at least one of the pages that use this endpoint. */
export async function assertPageAccess(userId: string, pages: readonly AppPage[]) {
  const allowed = await userPages(userId);
  if (!pages.some(page => allowed.includes(page))) throw new CatalogHttpError(403, '当前账号没有开通该页面，请联系管理员');
}

/**
 * Page gate for server components. A missing or expired session is left to the sign-in
 * redirect that already exists; this only turns away a signed-in account without the page.
 */
export async function requirePage(page: AppPage | '/admin') {
  if (workspaceOpenAccess()) return;
  const token = (await cookies()).get(CATALOG_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/u.test(token)) return;
  const found = await catalogDatabase().query(
    `SELECT u.role, u.tenant_id, u.allowed_pages FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`, [tokenHash(token)]);
  if (!found.rowCount) return;
  const row = found.rows[0] as AccessRow;
  const allowed = page === '/admin' ? row.role === 'admin' : pagesOf(row).includes(page);
  if (!allowed) redirect(page === '/admin' ? '/account' : `/account?denied=${encodeURIComponent(page)}`);
}
