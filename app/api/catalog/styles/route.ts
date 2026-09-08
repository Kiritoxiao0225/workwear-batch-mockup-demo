import { NextRequest, NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { listCatalogStyles } from '@/lib/server/catalog-repository';
import { catalogError } from '@/lib/server/catalog-http';
export async function GET(request: NextRequest) {
  try { await catalogUser(request); return NextResponse.json(await listCatalogStyles(Object.fromEntries(request.nextUrl.searchParams)), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return catalogError(error); }
}
