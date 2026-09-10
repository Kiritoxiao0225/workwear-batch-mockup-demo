import { NextRequest, NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';
import { productionThumbnail, PRODUCTION_THUMBNAIL_VERSION } from '@/lib/server/production-thumbnail';
import { catalogFile, readCatalogFile } from '@/lib/server/catalog-files';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await catalogUser(request);
    const id = (await context.params).id;
    const metadata = await catalogFile(id);
    const thumb = request.nextUrl.searchParams.get('size') === 'thumb';
    const etag = `"${metadata.sha256}${thumb ? `-${PRODUCTION_THUMBNAIL_VERSION}` : ''}"`;
    const headers = { 'Cache-Control': 'private, max-age=3600, immutable', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers });
    if (thumb) {
      const bytes = await productionThumbnail(id, metadata.sha256);
      return new NextResponse(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length) } });
    }
    const { file, bytes } = await readCatalogFile(id);
    return new NextResponse(new Uint8Array(bytes), { headers: {
      'Content-Type': file.mime_type, 'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=3600, immutable', 'ETag': `"${file.sha256}"`, 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return catalogError(error); }
}
