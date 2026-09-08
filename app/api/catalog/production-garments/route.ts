import { productionActionAssertion, ProductionArtworkConflictError } from '@/lib/production-artwork-snapshot';
import { withGarmentBodyScale } from '@/lib/server/wps-garment-sizing';
import { z } from 'zod';
import { catalogDetail } from '@/lib/server/catalog-repository';
import { bindingFromCatalog } from '@/lib/production-garment';
import { selectProductionGarment } from '@/lib/wps-production';
import { mutateWpsProductionState, ProductionRevisionConflictError } from '@/lib/server/wps-production-store';
import { after, NextRequest, NextResponse } from 'next/server';
import { usesProductionCloud } from '@/lib/server/production-storage';
import { finishProductionSave } from '@/lib/server/production-post-save';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { productionCatalogStyles } from '@/lib/server/wps-production-garments';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const selectionSchema = z.object({ action: z.literal('selectGarment'), expectedVersionSnapshot: z.string().min(1).max(3_000_000).optional(), expectedRevision: z.number().int().nonnegative(), unitId: z.string().min(1).max(300), variantId: z.uuid(), assetVersionId: z.uuid().optional() }).strict();
export async function GET(request: NextRequest) {
  try {
    await catalogUser(request);
    return NextResponse.json({ styles: await productionCatalogStyles() }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return catalogError(error); }
}

export async function POST(request: NextRequest) {
  try {
    await catalogUser(request, true);
    const input = selectionSchema.parse(await catalogJson(request));
    const detail = await catalogDetail(input.variantId, input.assetVersionId);
    const garment = await withGarmentBodyScale(bindingFromCatalog(detail, { selection: 'manual', colorText: '', evidence: `人工选择 ${detail.styleCode} · ${detail.colorName}` }));
    const saved = await mutateWpsProductionState(input.expectedRevision, state => selectProductionGarment(state, input.unitId, garment), productionActionAssertion(input));
    if (usesProductionCloud()) after(() => finishProductionSave(input));
    return NextResponse.json(saved);
  } catch (error) {
    if (error instanceof ProductionRevisionConflictError || error instanceof ProductionArtworkConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    return catalogError(error);
  }
}
