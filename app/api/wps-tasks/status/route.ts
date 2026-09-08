import { NextResponse } from 'next/server';
import { updateWpsTaskStatus } from '@/lib/server/wps-dbsheet';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象');
    const input = body as Record<string, unknown>;
    for (const key of ['recordId', 'expectedStatus', 'expectedEvidence', 'status']) {
      if (typeof input[key] !== 'string') throw new Error(`${key} 必须是字符串，实际值：${JSON.stringify(input[key])}`);
    }
    return NextResponse.json(await updateWpsTaskStatus(input.recordId as string, input.expectedStatus as string, input.expectedEvidence as string, input.status));
  } catch (error) {
    if (error instanceof CatalogHttpError) return catalogError(error);
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('WPS_USER_AUTH_REQUIRED:')) return NextResponse.json({ error: message, authorizeUrl: '/api/wps/oauth/start' }, { status: 401 });
    return NextResponse.json({ error: message }, { status: message.startsWith('WPS_SOURCE_CONFLICT:') ? 409 : 422 });
  }
}
