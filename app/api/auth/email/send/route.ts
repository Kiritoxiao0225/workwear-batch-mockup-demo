import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { requestIp } from '@/lib/server/auth-session';
import { EmailSendLimitError, requestEmailCode } from '@/lib/server/email-auth';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = z.object({ email: z.string().max(254), purpose: z.enum(['register', 'reset', 'setup']) }).strict().parse(await catalogJson(request));
    const { cooldownSeconds, expiresInSeconds, deliveryState } = await requestEmailCode({ email: body.email, purpose: body.purpose, ip: requestIp(request) });
    return NextResponse.json({ cooldownSeconds, expiresInSeconds, deliveryState }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof EmailSendLimitError) return NextResponse.json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds }, {
      status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(error.retryAfterSeconds) },
    });
    return catalogError(error);
  }
}
