import type { NextRequest } from 'next/server';
import { CatalogHttpError } from './catalog-auth';
import { tenantScope } from './tenant-scope';

/**
 * Platform administration. `users.role` is the platform role and is deliberately separate
 * from `users.tenant_role`, which only says who owns a tenant.
 */
export async function adminScope(request: NextRequest, write = false) {
  const scope = await tenantScope(request, write);
  if (scope.user.role !== 'admin') throw new CatalogHttpError(403, '需要管理员权限');
  return scope;
}
