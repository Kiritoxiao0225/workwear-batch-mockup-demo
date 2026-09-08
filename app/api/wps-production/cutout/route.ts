import { NextResponse } from 'next/server';
import { z } from 'zod';
import { productionUser, usesProductionCloud, persistProductionReferences, readProductionFile } from '@/lib/server/production-storage';
import { startArtworkCutout, queryArtworkCutout } from '@/lib/server/artwork-cutout';
import { analyzeArtworkCutout } from '@/lib/server/artwork-cutout-analysis';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { readCutoutJob } from '@/lib/server/artwork-cutout-store';
import { alignCutoutLayer } from '@/lib/server/artwork-cutout-layer';
export const runtime = 'nodejs';
export const maxDuration = 120;
const schema = z.object({ action: z.enum(['inspect', 'process', 'query', 'align']), targetUrl: z.string().max(500).optional(), mode: z.enum(['auto', 'standard', 'meitu']).default('auto'),
  image: z.string().max(16_000_000).optional(), jobKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(), retryOf: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    if (Number(request.headers.get('content-length')) > 17_000_000) throw new Error('抠图图片过大');
    const body = schema.parse(await request.json());
    if (body.action === 'align') {
      if (!body.jobKey || !body.targetUrl) throw new Error('缺少抠图任务或当前图层');
      const job = await readCutoutJob(body.jobKey);
      if (job?.status !== 'completed' || !job.url) throw new Error('抠图结果尚未完成');
      const bytes = await alignCutoutLayer(Buffer.from(job.url.split(',')[1], 'base64'), await readProductionFile(body.targetUrl));
      const result = { url: `data:image/png;base64,${bytes.toString('base64')}` };
      return NextResponse.json(usesProductionCloud() ? await persistProductionReferences(result) : result);
    }
    if (body.action === 'query') {
      if (!body.jobKey) throw new Error('缺少抠图任务标识');
      const result = await queryArtworkCutout(body.jobKey);
      return NextResponse.json(usesProductionCloud() ? await persistProductionReferences(result) : result);
    }
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u.exec(body.image ?? '');
    if (!match) throw new Error('请提供 PNG、JPEG 或 WebP 图片');
    const bytes = Buffer.from(match[1], 'base64');
    if (body.action === 'inspect') return NextResponse.json(await analyzeArtworkCutout(bytes, body.mode));
    const result = await startArtworkCutout(bytes, body.mode, { retryOf: body.retryOf });
    return NextResponse.json(usesProductionCloud() ? await persistProductionReferences(result) : result);
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof CatalogHttpError ? error.status : 400 }); }
}
