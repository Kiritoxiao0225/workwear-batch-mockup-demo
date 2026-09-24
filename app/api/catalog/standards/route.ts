import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { savePlacementStandard, savePlacementStandardBatch } from '@/lib/server/catalog-repository';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
export async function POST(request: NextRequest) {
  try {
    const { user: actor, tenant } = await tenantScope(request, true);
    const input = await catalogJson(request);
    const batch = input !== null && typeof input === 'object' && 'views' in input;
    return NextResponse.json(await (batch ? savePlacementStandardBatch(input, actor, tenant.id) : savePlacementStandard(input, actor, tenant.id)));
  }
  catch (error) { return catalogError(error); }
}
