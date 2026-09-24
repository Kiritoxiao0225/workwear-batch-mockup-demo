import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantScope } from '@/lib/server/tenant-scope';
import { assertFileAccess } from '@/lib/server/file-authorization';
import { readCatalogFile, signedCatalogFile } from '@/lib/server/catalog-files';
import { catalogError } from '@/lib/server/catalog-http';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { tenant } = await tenantScope(request);
    const id = z.uuid().parse((await context.params).id);
    // Before signing, before reading metadata, before any byte leaves the process.
    await assertFileAccess(id, tenant.id);
    const signed = await signedCatalogFile(id);
    if (signed) return new Response(null, { status: 302, headers: { Location: signed, 'Cache-Control': 'private, no-store' } });
    const { file, bytes } = await readCatalogFile(id);
    return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': file.mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return catalogError(error); }
}
