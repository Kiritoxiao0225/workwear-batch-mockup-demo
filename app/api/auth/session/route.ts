import { NextRequest, NextResponse } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { publicUser } from '@/lib/server/auth-session';
import { tenantScope } from '@/lib/server/tenant-scope';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Current account plus the tenant that owns its data. Used by the app shell. */
export async function GET(request: NextRequest) {
  try {
    const { user, tenant } = await tenantScope(request);
    return NextResponse.json({
      user: publicUser(user),
      tenant: {
        id: tenant.id, name: tenant.name, plan: tenant.plan,
        styleQuota: tenant.styleQuota, storageQuotaBytes: tenant.storageQuotaBytes,
        internal: tenant.workspace === 'main',
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
