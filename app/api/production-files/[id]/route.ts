import { NextRequest, NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';
import { readCatalogFile } from '@/lib/server/catalog-files';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await catalogUser(request);
    const { file, bytes } = await readCatalogFile((await context.params).id);
    return new NextResponse(new Uint8Array(bytes), { headers: {
      'Content-Type': file.mime_type, 'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=3600, immutable', 'ETag': `"${file.sha256}"`, 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return catalogError(error); }
}
