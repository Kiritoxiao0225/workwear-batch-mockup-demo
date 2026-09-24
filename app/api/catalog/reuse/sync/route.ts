import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { syncStyleStandards } from '@/lib/server/catalog-reuse';
export async function POST(request: NextRequest) {
  try {
    const { user: actor, tenant } = await tenantScope(request, true);
    return NextResponse.json(await syncStyleStandards(await catalogJson(request), actor, tenant.id), { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return catalogError(error); }
}
