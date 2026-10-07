import { NextRequest } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { endImpersonation } from '@/lib/server/impersonation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Leave an entered account and continue as the administrator who entered it. */
export async function POST(request: NextRequest) {
  try { return await endImpersonation(request); }
  catch (error) { return catalogError(error); }
}
