import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CatalogHttpError } from './catalog-auth';
import { GarmentBodyScaleError } from '@/lib/production-sizing';

export function catalogError(error: unknown) {
  const status = error instanceof CatalogHttpError ? error.status : error instanceof GarmentBodyScaleError ? 422 : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500;
  const message = error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') : error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function catalogJson(request: Request) {
  return JSON.parse((await catalogBody(request, 128 * 1024)).toString('utf8')) as unknown;
}
export async function catalogBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new CatalogHttpError(400, '请求内容为空');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new CatalogHttpError(413, `请求内容超过 ${limit} 字节`); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length);
  } finally { reader.releaseLock(); }
}
