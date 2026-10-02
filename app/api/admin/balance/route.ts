import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { setCreditBalance } from '@/lib/server/credits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const input = z.object({
  tenantId: z.uuid(),
  balanceCents: z.number().int().min(0).max(100_000_000),
  reason: z.string().min(1).max(200),
}).strict();

/** Set the spendable balance to an exact figure; the difference is recorded in the ledger. */
export async function POST(request: NextRequest) {
  try {
    const { user } = await adminScope(request, true);
    const body = input.parse(await catalogJson(request));
    return NextResponse.json(await setCreditBalance(body.tenantId, body.balanceCents, body.reason, user.id),
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
