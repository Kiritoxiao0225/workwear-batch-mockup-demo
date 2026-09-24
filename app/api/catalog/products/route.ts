import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { listCatalog } from '@/lib/server/catalog-repository';
import { catalogError } from '@/lib/server/catalog-http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    const { tenant } = await tenantScope(request);
    return NextResponse.json(await listCatalog(Object.fromEntries(request.nextUrl.searchParams), tenant.id), { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return catalogError(error); }
}
