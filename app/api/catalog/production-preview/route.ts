import { after, NextRequest, NextResponse } from 'next/server';
import { usesProductionCloud } from '@/lib/server/production-storage';
import { finishProductionSave } from '@/lib/server/production-post-save';
import { catalogUser, CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { renderProductionPreview } from '@/lib/server/wps-production-assets';
import { prepareProductionPreview } from '@/lib/server/production-render-cache';
import { productionPreviewRevision } from '@/lib/production-preview';
import sharp from 'sharp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const started = performance.now();
  try {
    await catalogUser(request);
    const versionId = request.nextUrl.searchParams.get('versionId');
    if (!versionId) throw new CatalogHttpError(400, `versionId 不能为空，实际值：${versionId}`);
    const state = await readWpsProductionState();
    const version = state.mockupVersions.find(version => version.id === versionId);
    if (!version) throw new CatalogHttpError(404, `找不到效果图版本：${versionId}`);
    const units = version.unitIds.map(id => {
      const unit = state.units.find(unit => unit.id === id);
      if (!unit) throw new Error(`版本 ${versionId} 引用了不存在的定制单元：${id}`);
      return unit;
    });
    const revision = request.nextUrl.searchParams.get('revision');
    if (revision && revision !== productionPreviewRevision(version, units)) {
      throw new CatalogHttpError(409, '效果图内容已更新，请读取最新制作状态');
    }
    // Show available artwork immediately; draft preview does not change confirmation gates.
    const prepared = usesProductionCloud() ? await prepareProductionPreview(version, units) : null;
    const png = prepared?.bytes ?? await renderProductionPreview(version, units);
    if (prepared) after(async () => {
      try { await prepared.persist(); }
      catch (error) { console.error('高清效果图保存未完成；预览已返回，后续读取可重试', error); }
      finally { await finishProductionSave(); }
    });
    const card = request.nextUrl.searchParams.get('size') === 'card';
    const image = card ? await sharp(png).resize({ width: 1084, withoutEnlargement: true }).webp({ quality: 90 }).toBuffer() : png;
    return new NextResponse(new Uint8Array(image), { headers: {
      'Content-Type': card ? 'image/webp' : 'image/png', 'Content-Disposition': 'inline',
      'Content-Length': String(image.length), 'Server-Timing': `preview;dur=${Math.round(performance.now() - started)}`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return catalogError(error); }
}
