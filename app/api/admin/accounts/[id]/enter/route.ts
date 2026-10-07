import { NextRequest } from 'next/server';
import { z } from 'zod';
import { catalogError } from '@/lib/server/catalog-http';
import { startImpersonation } from '@/lib/server/impersonation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

/** Switch this browser into another account; the administrator's own session waits for the way back. */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    return await startImpersonation(request, z.uuid().parse(id));
  } catch (error) { return catalogError(error); }
}
