import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { listCatalogStyles } from '@/lib/server/catalog-repository';
import { catalogError } from '@/lib/server/catalog-http';
import { signedCatalogThumbnails } from '@/lib/server/catalog-files';
export async function GET(request: NextRequest) {
  try {
    const { tenant } = await tenantScope(request);
    const page = await listCatalogStyles(Object.fromEntries(request.nextUrl.searchParams), tenant.id);
    const cards = page.items.map(style => style.colors.find(color => color.id === style.referenceVariantId && style.matchedIds.includes(color.id))
      ?? style.colors.find(color => style.matchedIds.includes(color.id)) ?? style.colors[0]);
    const urls = await signedCatalogThumbnails(cards.map(item => item.thumbnailUrl));
    for (const item of cards) item.signedThumbnailUrl = urls.get(item.thumbnailUrl);
    return NextResponse.json(page, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  catch (error) { return catalogError(error); }
}
