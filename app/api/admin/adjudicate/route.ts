import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { adjudicateHold } from '@/lib/server/credits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const input = z.object({
  holdId: z.string().min(1).max(200),
  tenantId: z.uuid(),
  decision: z.enum(['charge', 'refund']),
}).strict();

/** Rules on a frozen charge whose outcome the system refused to guess. */
export async function POST(request: NextRequest) {
  try {
    const { user } = await adminScope(request, true);
    const body = input.parse(await catalogJson(request));
    const result = await adjudicateHold(body.holdId, body.tenantId, body.decision, user.id);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
