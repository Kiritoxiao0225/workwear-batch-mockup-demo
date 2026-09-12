import { productionPreviewFixed } from '@/lib/production-preview';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { trackedProductionRender } from '@/lib/server/production-render-recovery';
import { preflightResolvedArtworkUnit } from '@/lib/server/artwork-preflight';
import { safeErrorText } from '@/lib/artwork-reliability';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
const schema = z.object({ versionIds: z.array(z.string().min(1).max(1000)).min(1).max(20) }).strict();
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const { versionIds } = schema.parse(await request.json());
    const results = [];
    for (const id of new Set(versionIds)) {
      try {
        const state = await readWpsProductionState();
        const version = state.mockupVersions.find(item => item.id === id);
        if (!version) throw new Error('效果图版本已不存在');
        if (version.finalConfirmation) throw new Error('已确认的历史成品不原地重合成；请先从制作明细建立新版本');
        const units = version.unitIds.map(unitId => state.units.find(unit => unit.id === unitId)!);
        if (units.some(unit => !unit?.artwork)) throw new Error('还有位置没有保存图稿，不能当完整效果图合成');
        const source = state.records.find(record => record.source.recordId === version.sourceRecordId)?.source;
        if (!source) throw new Error('原始订单已不存在');
        const checks = await Promise.all(units.map(unit => preflightResolvedArtworkUnit(unit, source, 'preview', { fixed: productionPreviewFixed(unit, [version]) })));
        const issue = checks.flatMap(check => [check.garmentIssue, check.artworkIssue].filter(Boolean)).join('；');
        if (issue) throw new Error(issue);
        const before = units.map(unit => unit.artwork!.validation.sha256);
        const result = await trackedProductionRender(version, units);
        results.push({ versionId: id, status: 'ready', url: `/api/production-files/${result.file.id}`, artworkSha256: before,
          paidGenerationCalls: 0, paidCutoutCalls: 0 });
      } catch (error) { results.push({ versionId: id, status: 'failed', error: safeErrorText(error) }); }
    }
    return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: safeErrorText(error) }, { status: error instanceof CatalogHttpError ? error.status : 400 }); }
}
