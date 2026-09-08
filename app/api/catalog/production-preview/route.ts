import { after, NextRequest, NextResponse } from 'next/server';
import { usesProductionCloud } from '@/lib/server/production-storage';
import { finishProductionSave } from '@/lib/server/production-post-save';
import { catalogUser, CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogError } from '@/lib/server/catalog-http';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { renderProductionPreview } from '@/lib/server/wps-production-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
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
    // Show available artwork immediately; draft preview does not change confirmation gates.
    const png = await renderProductionPreview(version, units);
    if (usesProductionCloud()) after(() => finishProductionSave());
    return new NextResponse(new Uint8Array(png), { headers: {
      'Content-Type': 'image/png', 'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return catalogError(error); }
}
