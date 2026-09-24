import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { publicUser, requestIp, sessionResponse } from '@/lib/server/auth-session';
import { signInWithPhone } from '@/lib/server/phone-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const input = z.object({ phone: z.string().min(11).max(11), code: z.string().min(6).max(6) }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = input.parse(await catalogJson(request));
    const result = await signInWithPhone({ phone: body.phone, code: body.code, ip: requestIp(request) });
    return sessionResponse({ user: publicUser(result.user) }, result.token);
  } catch (error) { return catalogError(error); }
}
