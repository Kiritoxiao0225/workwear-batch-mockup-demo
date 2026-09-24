import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { verifyEmailCode } from '@/lib/server/email-auth';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = z.object({ email: z.string().max(254), purpose: z.enum(['register','reset','setup']), code: z.string().regex(/^\d{6}$/u) }).strict().parse(await catalogJson(request));
    return NextResponse.json(await verifyEmailCode(body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
