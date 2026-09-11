import { NextRequest, NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { savePlacementStandard, savePlacementStandardBatch } from '@/lib/server/catalog-repository';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
export async function POST(request: NextRequest) {
  try {
    const actor = await catalogUser(request, true);
    const input = await catalogJson(request);
    const batch = input !== null && typeof input === 'object' && 'views' in input;
    return NextResponse.json(await (batch ? savePlacementStandardBatch(input, actor) : savePlacementStandard(input, actor)));
  }
  catch (error) { return catalogError(error); }
}
