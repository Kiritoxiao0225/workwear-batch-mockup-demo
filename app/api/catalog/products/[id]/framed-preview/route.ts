import { CONFIRMATION_FRAME } from '@/lib/confirmation-frame';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogDetail } from '@/lib/server/catalog-repository';
import { readCatalogFile } from '@/lib/server/catalog-files';
import { catalogError } from '@/lib/server/catalog-http';
import { renderConfirmationFrame } from '@/lib/server/confirmation-frame';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { tenant } = await tenantScope(request);
    const detail = await catalogDetail((await context.params).id, request.nextUrl.searchParams.get('assetVersionId') ?? undefined, tenant.id);
    const [{ bytes }, frame] = await Promise.all([
      readCatalogFile(detail.imageUrl.split('/').at(-1)!),
      readFile(path.join(process.cwd(), 'public', CONFIRMATION_FRAME.assetPath)),
    ]);
    const png = await renderConfirmationFrame(bytes, frame, detail.views.map(view => ({ face: view.face, crop: view.crop })));
    return new NextResponse(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return catalogError(error); }
}
