import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { requestIp } from '@/lib/server/auth-session';
import { requestPhoneCode } from '@/lib/server/phone-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const input = z.object({
  phone: z.string().min(11).max(11),
  captchaToken: z.string().max(2048).optional(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    if (process.env.SMS_LOGIN_ENABLED === '0') throw new CatalogHttpError(503, '短信登录暂不可用，请使用邮箱登录');
    const body = input.parse(await catalogJson(request));
    const sent = await requestPhoneCode({ phone: body.phone, ip: requestIp(request), captchaToken: body.captchaToken });
    // `mockCode` never leaves the server: it exists only under the mock provider, which
    // production rejects, and is used by the integration test rather than any client.
    return NextResponse.json(
      { cooldownSeconds: sent.cooldownSeconds, expiresInSeconds: sent.expiresInSeconds },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
