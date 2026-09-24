import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { publicUser, sessionResponse, clearedSessionResponse } from '@/lib/server/auth-session';
import { completeEmailPassword } from '@/lib/server/email-auth';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = z.object({ email: z.string().max(254), purpose: z.enum(['register','reset','setup']), verificationToken: z.string().regex(/^[a-f0-9]{64}$/u), password: z.string().min(8).max(256), confirmPassword: z.string().min(8).max(256) }).strict()
      .refine(input => input.password === input.confirmPassword, { message: '两次输入的密码不一致' }).parse(await catalogJson(request));
    const result = await completeEmailPassword(body);
    return result.kind === 'registered' ? sessionResponse({ user: publicUser(result.user) }, result.token) : clearedSessionResponse({ ok: true });
  } catch (error) { return catalogError(error); }
}
