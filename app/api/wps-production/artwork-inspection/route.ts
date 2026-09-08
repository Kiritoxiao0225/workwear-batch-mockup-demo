import { productionUser } from '@/lib/server/production-storage';
import { withGarmentBodyScale } from '@/lib/server/wps-garment-sizing';
import { verifyGarmentBinding } from '@/lib/server/wps-production-garments';
import { NextResponse } from 'next/server';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { validateProductionArtwork } from '@/lib/server/wps-production-assets';
import { retainArtworkQuality } from '@/lib/artwork-acceptance';
export async function GET(request: Request) {
  try {
    await productionUser(request, true);
    const unitId = new URL(request.url).searchParams.get('unitId');
    const sizing = new URL(request.url).searchParams.get('sizing') === 'true';
    const unit = (await readWpsProductionState()).units.find(unit => unit.id === unitId);
    if (!unit || (!unit.artwork && !sizing)) return NextResponse.json({ error: `找不到图案：${unitId}` }, { status: 404 });
    const validation = unit.artwork ? await validateProductionArtwork(unit.artwork.url) : null;
    if (validation && validation.sha256 !== unit.artwork!.validation.sha256) return NextResponse.json({ error: '图案文件已变化，请重新上传并确认' }, { status: 409 });
    if (sizing && unit.garment) await verifyGarmentBinding(unit.garment);
    const garment = sizing && unit.garment ? await withGarmentBodyScale(unit.garment) : undefined;
    return NextResponse.json({ unitId, validation: validation ? retainArtworkQuality(unit.artwork!.validation, validation) : null, garment }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}

// Inspection retains editor and same-origin checks. Browser POST requests carry Origin.
export const POST = GET;
