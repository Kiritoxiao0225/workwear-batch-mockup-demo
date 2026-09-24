import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogDetail } from '@/lib/server/catalog-repository';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { recognizeCatalogApron } from '@/lib/server/catalog-apron-recognition';
export const maxDuration = 240;
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { tenant } = await tenantScope(request, true);
    const input = z.object({ assetVersionId: z.uuid() }).strict().parse(await catalogJson(request));
    const detail = await catalogDetail((await context.params).id, input.assetVersionId, tenant.id);
    if (!detail.isCurrent) throw new CatalogHttpError(409, '历史底图只读，请打开当前底图识别');
    return NextResponse.json(await recognizeCatalogApron(detail), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
