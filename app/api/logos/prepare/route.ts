import { NextResponse } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { productionUser, usesProductionCloud } from '@/lib/server/production-storage';
import { claimProductionUpload } from '@/lib/server/production-upload';
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    if (!usesProductionCloud()) return NextResponse.json({ status: 'local' });
    const { sha256, operationId } = await request.json();
    return NextResponse.json(await claimProductionUpload(sha256, operationId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
