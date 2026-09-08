import { NextResponse } from 'next/server';

import { parseLogoStudioRequest } from '@/lib/logo-studio';
import { runLogoStudio } from '@/lib/server/ark-logo-studio';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';

export const runtime = 'nodejs';
export const maxDuration = 180;

const MAX_REQUEST_BYTES = 34 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: `请求不能超过 34MB，实际 ${contentLength}B` }, { status: 413 });
    }
    const input = parseLogoStudioRequest(await request.json());
    return NextResponse.json(await runLogoStudio(input));
  } catch (error) {
    if (error instanceof CatalogHttpError) return catalogError(error);
    const message = error instanceof Error ? error.message : String(error);
    const configurationError = message.includes('is not configured');
    const inferenceLimitError = message.includes('安心体验') && message.includes('服务已暂停');
    const inputError = message.startsWith('Logo 处理请求')
      || message.startsWith('instruction')
      || message.startsWith('image');
    return NextResponse.json(
      { error: message },
      { status: configurationError ? 503 : inferenceLimitError ? 429 : inputError ? 400 : 502 },
    );
  }
}
