import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogStyle } from '@/lib/server/catalog-repository';
import { catalogError } from '@/lib/server/catalog-http';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { tenant } = await tenantScope(request);
    return NextResponse.json(await catalogStyle((await context.params).id, tenant.id), { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return catalogError(error); }
}
