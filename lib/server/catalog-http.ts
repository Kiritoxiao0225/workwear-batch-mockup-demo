import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CatalogHttpError } from './catalog-auth';
import { GarmentBodyScaleError } from '@/lib/production-sizing';

export function catalogError(error: unknown) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!(error instanceof CatalogHttpError || error instanceof GarmentBodyScaleError || error instanceof ZodError || error instanceof SyntaxError)) {
    // An unplanned error can carry database hosts, object keys or SQL; the browser only gets a
    // reference to find the full error in the server log.
    const ref = randomBytes(4).toString('hex');
    console.error('[api]', ref, error);
    return NextResponse.json({ error: `服务暂时出错，请稍后重试（编号 ${ref}）` }, { status: 500, headers });
  }
  const status = error instanceof CatalogHttpError ? error.status : error instanceof GarmentBodyScaleError ? 422 : 400;
  const message = error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') : error.message;
  return NextResponse.json({ error: message }, { status, headers });
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
