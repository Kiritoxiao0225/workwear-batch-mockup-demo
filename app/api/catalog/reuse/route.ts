import { NextRequest, NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { previewStandardReuse, applyStandardReuse } from '@/lib/server/catalog-reuse';
export async function POST(request: NextRequest) {
  try { const actor = await catalogUser(request, true); return NextResponse.json(await previewStandardReuse(await catalogJson(request), actor), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return catalogError(error); }
}
export async function PUT(request: NextRequest) {
  try { const actor = await catalogUser(request, true); return NextResponse.json(await applyStandardReuse(await catalogJson(request), actor)); }
  catch (error) { return catalogError(error); }
}
