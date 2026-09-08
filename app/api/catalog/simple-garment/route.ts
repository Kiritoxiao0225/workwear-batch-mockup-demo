import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';
import { catalogDetail } from '@/lib/server/catalog-repository';
import { bindingFromCatalog } from '@/lib/production-garment';
import { catalogPlacementPreview } from '@/lib/server/catalog-placement-preview';
import { withGarmentBodyScale } from '@/lib/server/wps-garment-sizing';

export const dynamic = 'force-dynamic';
const querySchema = z.object({ variantId: z.uuid(), assetVersionId: z.uuid() }).strict();

// Read a pinned catalog snapshot without creating or modifying a WPS order.
export async function GET(request: NextRequest) {
  try {
    await catalogUser(request);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const detail = await catalogDetail(query.variantId, query.assetVersionId);
    const [garment, placementDefaults] = await Promise.all([withGarmentBodyScale(bindingFromCatalog(detail, {
      selection: 'manual', colorText: detail.colorName, evidence: `简单批量生图选款 ${detail.styleCode} · ${detail.colorName}`,
    })), catalogPlacementPreview(detail)]);
    return NextResponse.json({ garment, placementDefaults }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return catalogError(error); }
}
