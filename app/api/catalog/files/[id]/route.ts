import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogUser } from '@/lib/server/catalog-auth';
import { readCatalogFile, signedCatalogFile } from '@/lib/server/catalog-files';
import { catalogError } from '@/lib/server/catalog-http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await catalogUser(request);
    const id = z.uuid().parse((await context.params).id);
    const signed = await signedCatalogFile(id);
    if (signed) return new Response(null, { status: 302, headers: { Location: signed, 'Cache-Control': 'private, no-store' } });
    const { file, bytes } = await readCatalogFile(id);
    return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': file.mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return catalogError(error); }
}
