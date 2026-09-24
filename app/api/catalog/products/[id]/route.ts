import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogDetail } from '@/lib/server/catalog-repository';
import { catalogError } from '@/lib/server/catalog-http';
import { catalogPlacementPreview } from '@/lib/server/catalog-placement-preview';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { tenant } = await tenantScope(request);
    const detail = await catalogDetail((await context.params).id, request.nextUrl.searchParams.get('assetVersionId') ?? undefined, tenant.id);
    return NextResponse.json({ ...detail, ...(request.nextUrl.searchParams.get('placementPreview') === '1' ? { placementPreview: await catalogPlacementPreview(detail) } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return catalogError(error); }
}
