import { NextRequest, NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogStyle } from '@/lib/server/catalog-repository';
import { catalogError } from '@/lib/server/catalog-http';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { await catalogUser(request); return NextResponse.json(await catalogStyle((await context.params).id), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return catalogError(error); }
}
