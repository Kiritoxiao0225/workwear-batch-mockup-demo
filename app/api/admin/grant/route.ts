import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { grantCredits } from '@/lib/server/credits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const input = z.object({
  tenantId: z.uuid(),
  amountCents: z.number().int().refine(value => value !== 0, '发放数量不能为 0'),
  reason: z.string().min(1).max(200),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const { user } = await adminScope(request, true);
    const body = input.parse(await catalogJson(request));
    const result = await grantCredits(body.tenantId, body.amountCents, body.reason, user.id);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
