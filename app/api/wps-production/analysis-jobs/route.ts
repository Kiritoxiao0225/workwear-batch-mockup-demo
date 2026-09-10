import { NextResponse } from 'next/server';
import { z } from 'zod';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { enqueueWpsAnalysis, readWpsAnalysisJobs, wpsAnalysisJobsEnabled } from '@/lib/server/wps-analysis-jobs';
import { listWpsSourceTaskRecords } from '@/lib/server/wps-dbsheet';
import { wpsSourceEvidence } from '@/lib/wps-source';
import { conditionalJson } from '@/lib/server/conditional-json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const input = z.object({ records: z.array(z.object({ recordId: z.string().min(1), evidence: z.string().min(1).max(200_000) })).min(1).max(30), retry: z.boolean().optional() });
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof CatalogHttpError ? error.status : 400 });
}
export async function GET(request: Request) {
  try { await productionUser(request); return conditionalJson(await readWpsAnalysisJobs(), request); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    if (!wpsAnalysisJobsEnabled()) return NextResponse.json({ error: '后台解析尚未启用' }, { status: 503 });
    const body = input.parse(await request.json());
    const { records } = await listWpsSourceTaskRecords({ recordIds: body.records.map(record => record.recordId), downloadMaterials: false });
    const results = [];
    for (const requested of body.records) {
      try {
        const current = records.find(record => record.recordId === requested.recordId);
        if (!current || wpsSourceEvidence(current) !== requested.evidence) throw new Error('WPS 原文或附件已变化，请重新同步');
        results.push({ recordId: current.recordId, ...await enqueueWpsAnalysis(current, body.retry) });
      } catch (error) { results.push({ recordId: requested.recordId, error: error instanceof Error ? error.message : String(error) }); }
    }
    return NextResponse.json({ ...await readWpsAnalysisJobs(), results });
  } catch (error) { return failure(error); }
}
