import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { preflightArtworkOperation } from '@/lib/server/artwork-preflight';
import { productionArtworkSnapshot, productionSharedSnapshot } from '@/lib/production-artwork-snapshot';
import { sharedArtworkForUnit, sharedArtworkLeader } from '@/lib/shared-artwork';
import { canonicalJson, safeErrorText } from '@/lib/artwork-reliability';
import { POST as submitJobs } from '../jobs/route';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
const schema = z.object({ action: z.enum(['check', 'enqueue']), target: z.enum(['artwork', 'mockup']),
  unitIds: z.array(z.string().min(1).max(500)).min(1).max(100), reviewToken: z.string().max(100).optional() }).strict();
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const input = schema.parse(await request.json());
    const state = await readWpsProductionState();
    const seen = new Set<string>();
    const results = [], enqueue = [];
    for (const id of new Set(input.unitIds)) {
      const original = state.units.find(unit => unit.id === id);
      if (!original) { results.push({ unitId: id, blockers: ['该位置已不存在'] }); continue; }
      const unit = sharedArtworkLeader(state, original);
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      const source = state.records.find(record => record.source.recordId === unit.sourceRecordId)?.source;
      if (!source) { results.push({ unitId: unit.id, blockers: ['原始订单已不存在'] }); continue; }
      try {
        const checked = await preflightArtworkOperation(state, unit, source, input.target);
        const blockers = [...checked.blockers];
        if (unit.artwork) blockers.push('图稿已保存；无需批量重做，请核对图稿或只重合成效果图');
        const group = sharedArtworkForUnit(state, unit.id);
        results.push({ unitId: unit.id, blockers: [...new Set(blockers)], garmentIssue: checked.garmentIssue, inputs: checked.contract.inputs, calibrationUrl: checked.calibrationUrl, temporaryPlacement: checked.temporaryPlacement, garmentChecks: checked.garmentChecks });
        if (!blockers.length) enqueue.push({ unitId: unit.id, snapshot: productionArtworkSnapshot(unit, source), ...(group ? { sharedSnapshot: productionSharedSnapshot(state, unit.id) } : {}) });
      } catch (error) { results.push({ unitId: unit.id, blockers: [safeErrorText(error)] }); }
    }
    const reviewToken = createHash('sha256').update(canonicalJson({ target: input.target, requested: [...new Set(input.unitIds)].sort(), enqueue })).digest('hex');
    if (input.action === 'check') return NextResponse.json({ results, eligible: enqueue.length, reviewToken, sourceFreshness: 'stored-snapshot; enqueue rechecks live WPS' }, { headers: { 'Cache-Control': 'no-store' } });
    if (!input.reviewToken || input.reviewToken !== reviewToken) return NextResponse.json({ error: '订单、共享关系或要求已变化，请重新预检', results }, { status: 409 });
    if (!enqueue.length) return NextResponse.json({ error: '本批没有可提交的位置', results }, { status: 409 });
    const headers = new Headers(request.headers); headers.delete('content-length'); headers.set('content-type', 'application/json');
    const forwarded = new Request(new URL('/api/wps-production/jobs', request.url), { method: 'POST', headers,
      body: JSON.stringify({ action: 'enqueue', target: input.target, units: enqueue }) });
    return submitJobs(forwarded);
  } catch (error) { return NextResponse.json({ error: safeErrorText(error) }, { status: error instanceof CatalogHttpError ? error.status : 400 }); }
}
