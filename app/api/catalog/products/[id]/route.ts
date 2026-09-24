import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogDetail, catalogStyle } from '@/lib/server/catalog-repository';
import { readCatalogFile } from '@/lib/server/catalog-files';
import { catalogError } from '@/lib/server/catalog-http';
import { catalogPlacementPreview } from '@/lib/server/catalog-placement-preview';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { tenant } = await tenantScope(request);
    const detail = await catalogDetail((await context.params).id, request.nextUrl.searchParams.get('assetVersionId') ?? undefined, tenant.id);
    if (request.nextUrl.searchParams.get('placementPreview') !== '1') return NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } });
    // Unconfirmed colors show the style's confirmed structure points exactly as the composite uses them.
    const load = async (id: string) => { const source = await catalogDetail(id, undefined, tenant.id); return { detail: source, bytes: (await readCatalogFile(source.thumbnailUrl.split('/').at(-1)!)).bytes }; };
    const placementPreview = await catalogPlacementPreview(detail, { style: await catalogStyle(detail.styleId, tenant.id), load });
    return NextResponse.json({ ...detail, placementPreview }, { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return catalogError(error); }
}
