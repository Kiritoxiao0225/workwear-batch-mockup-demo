import type { NextRequest } from 'next/server';
import type { CatalogUser } from '@/lib/catalog';
import { catalogUser, CatalogHttpError, INTERNAL_TENANT_ID } from './catalog-auth';
import { catalogDatabase } from './catalog-database';

export type Tenant = {
  id: string;
  name: string;
  plan: 'free' | 'pro' | 'internal';
  billingMode: 'charge' | 'exempt';
  styleQuota: number;
  storageQuotaBytes: number;
  workspace: string;
};

// The WPS delivery runs in this workspace. Any path without tenant context resolves here so
// existing callers keep their current behaviour.
export const DEFAULT_WORKSPACE = 'main';

type TenantRow = {
  id: string; name: string; plan: Tenant['plan']; billing_mode: Tenant['billingMode'];
  style_quota: number; storage_quota_bytes: string | number; workspace: string;
};

const asTenant = (row: TenantRow): Tenant => ({
  id: row.id,
  name: row.name,
  plan: row.plan,
  billingMode: row.billing_mode,
  styleQuota: Number(row.style_quota),
  storageQuotaBytes: Number(row.storage_quota_bytes),
  workspace: row.workspace,
});

const TENANT_COLUMNS = 'id,name,plan,billing_mode,style_quota,storage_quota_bytes,workspace';

export async function tenantById(id: string): Promise<Tenant | null> {
  const found = await catalogDatabase().query(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE id=$1 AND NOT disabled`, [id]);
  return found.rowCount ? asTenant(found.rows[0] as TenantRow) : null;
}

export async function tenantByWorkspace(workspace: string): Promise<Tenant | null> {
  const found = await catalogDatabase().query(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE workspace=$1 AND NOT disabled`, [workspace]);
  return found.rowCount ? asTenant(found.rows[0] as TenantRow) : null;
}

export const isInternalTenant = (tenant: Tenant) => tenant.id === INTERNAL_TENANT_ID;

/**
 * Resolve the signed-in user together with the tenant that owns their data.
 * Write requests keep the existing same-origin and role checks from `catalogUser`.
 */
export async function tenantScope(request: NextRequest, write = false): Promise<{ user: CatalogUser; tenant: Tenant }> {
  const user = await catalogUser(request, write);
  const found = await catalogDatabase().query(
    `SELECT ${TENANT_COLUMNS.split(',').map(column => `t.${column}`).join(',')} FROM tenants t
      JOIN users u ON u.tenant_id = t.id
      WHERE u.id = $1 AND NOT t.disabled`, [user.id]);
  if (!found.rowCount) throw new CatalogHttpError(403, '账号未开通工作区或已停用');
  return { user, tenant: asTenant(found.rows[0] as TenantRow) };
}

/** Same as `tenantScope` but rejects anyone outside the internal tenant. */
export async function internalScope(request: NextRequest, write = false) {
  const scope = await tenantScope(request, write);
  if (!isInternalTenant(scope.tenant)) throw new CatalogHttpError(403, '该功能仅限内部账号');
  return scope;
}

/**
 * Workspace for storage and queue access. Callers without tenant context keep using the
 * delivery workspace, which is what `/wps-production` already does today.
 */
export const workspaceFor = (tenant?: Tenant | null) => tenant?.workspace ?? DEFAULT_WORKSPACE;
