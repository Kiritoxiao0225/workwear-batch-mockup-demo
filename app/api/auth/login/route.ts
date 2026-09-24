import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, loginCatalog } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { publicUser, sessionResponse, requestIp } from '@/lib/server/auth-session';

import { limitPasswordLogin } from '@/lib/server/password-login-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const input = z.object({ email: z.string().max(254), password: z.string().min(1).max(256) }).strict();

/** Password is the primary sign-in method; email verification is for registration/recovery. */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = input.parse(await catalogJson(request));
    await limitPasswordLogin(requestIp(request));
    const result = await loginCatalog(body.email, body.password);
    return sessionResponse({ user: publicUser(result.user) }, result.token);
  } catch (error) { return catalogError(error); }
}
