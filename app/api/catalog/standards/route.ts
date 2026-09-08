import { NextRequest, NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { savePlacementStandard } from '@/lib/server/catalog-repository';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
export async function POST(request: NextRequest) {
  try { const actor = await catalogUser(request, true); return NextResponse.json(await savePlacementStandard(await catalogJson(request), actor)); }
  catch (error) { return catalogError(error); }
}
