import { NextRequest, NextResponse } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { tenantScope } from '@/lib/server/tenant-scope';
import { storageUsage } from '@/lib/server/storage-usage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Where the signed-in account's storage goes, for the 存储空间 page. */
export async function GET(request: NextRequest) {
  try {
    const { tenant } = await tenantScope(request);
    return NextResponse.json(await storageUsage(tenant.id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
