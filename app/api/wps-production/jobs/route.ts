import { assertActiveSourceStatus } from '@/lib/artwork-reliability';
import { preflightResolvedArtworkUnit, verifyArtworkInputFiles, verifyLiveArtworkSource } from '@/lib/server/artwork-preflight';
import { currentArtworkReview } from '@/lib/artwork-review-ledger';
import { artworkCorrectionIssues } from '@/lib/artwork-correction';
import { readArtworkRoutingReport } from '@/lib/server/artwork-routing-records';
import { conditionalJson } from '@/lib/server/conditional-json';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { normalizeProductionTextPlan } from '@/lib/wps-production';
import { readWpsProductionState, mutateWpsProductionState } from '@/lib/server/wps-production-store';
import { assertProductionArtworkSnapshot, productionArtworkSnapshot, ProductionArtworkConflictError } from '@/lib/production-artwork-snapshot';
import { artworkJobsEnabled, readArtworkJobs, enqueueArtworkJob, changeArtworkJob } from '@/lib/server/artwork-job-store';
import { artworkPlanIssues, isTextOnlyArtwork } from '@/lib/artwork-reference';
import { productionArtworkRouting } from '@/lib/production-recipe';
import { sharedArtworkForUnit, sharedArtworkLeader } from '@/lib/shared-artwork';
import { assertProductionSharedSnapshot, productionSharedSnapshot } from '@/lib/production-artwork-snapshot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
const inputSchema = z.union([
  z.object({ action: z.literal('enqueue'), target: z.enum(['artwork', 'mockup']).optional(), units: z.array(z.object({ unitId: z.string().min(1), snapshot: z.string().min(1).max(100_000), sharedSnapshot: z.string().min(1).max(10_000_000).optional(), correction: z.object({ baseRunId: z.string().min(1).max(64), issueIds: z.array(z.string().max(40)).min(1).max(30) }).optional() })).min(1).max(100) }),
  z.object({ action: z.enum(['cancel', 'retry']), id: z.string().uuid() }),
]);
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof CatalogHttpError ? error.status : error instanceof ProductionArtworkConflictError ? 409 : 400 });
}
export async function GET(request: Request) {
  try { await productionUser(request); return conditionalJson(await readArtworkJobs(), request); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    if (!artworkJobsEnabled()) return NextResponse.json({ error: '云端制作队列尚未启用' }, { status: 503 });
    const body = inputSchema.parse(await request.json());
    if (body.action !== 'enqueue') {
      // A retry preserves the original snapshot, input and all completed steps.
      if (body.action === 'retry') {
        const jobs = await readArtworkJobs();
        if (!jobs.jobs.some(job => job.id === body.id)) throw new Error('找不到后台任务');
      }
      await changeArtworkJob(body.id, body.action);
      return NextResponse.json(await readArtworkJobs());
    }
    let state = await readWpsProductionState();
    const results = [];
    const verifiedInputs = new Map<string, Promise<void>>();
    const verifiedSources = new Map<string, Promise<void>>();
    for (const requested of body.units) {
      try {
        assertProductionArtworkSnapshot(state, requested.unitId, requested.snapshot);
        let unit = state.units.find(unit => unit.id === requested.unitId)!;
        if (sharedArtworkForUnit(state, unit.id)) {
          if (!requested.sharedSnapshot) throw new Error('请刷新页面后从共用图稿入口制作');
          assertProductionSharedSnapshot(state, unit.id, requested.sharedSnapshot);
          unit = sharedArtworkLeader(state, unit);
        }
        if (isTextOnlyArtwork(unit) && (unit.route !== 'deterministic' || unit.generationPrompt)) {
          const unitId = unit.id;
          const before = productionArtworkSnapshot(unit, state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source);
          const sharedBefore = sharedArtworkForUnit(state, unitId) ? productionSharedSnapshot(state, unitId) : undefined;
          state = await mutateWpsProductionState(state.revision, current => normalizeProductionTextPlan(current, unitId), current => {
            assertProductionArtworkSnapshot(current, unitId, before);
            if (sharedBefore) assertProductionSharedSnapshot(current, unitId, sharedBefore);
          });
          unit = state.units.find(candidate => candidate.id === unitId)!;
        }
        const source = state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source;
        if (source.wpsSource) assertActiveSourceStatus(source.wpsSource.status);
        await verifyLiveArtworkSource(source, verifiedSources);
        const preflight = await preflightResolvedArtworkUnit(unit, source, body.target ?? 'artwork');
        if (preflight.blockers.length) throw new Error(preflight.blockers.join('；'));
        await verifyArtworkInputFiles(source, unit, verifiedInputs);
        const issues = artworkPlanIssues(source, unit);
        if (issues.length) throw new Error(issues.join('；'));
        if (unit.attempts.some(attempt => ['submitted', 'processing', 'unknownSubmission'].includes(attempt.status))) throw new Error('已有制作任务未结束');
        const routing = productionArtworkRouting({ ...unit, artwork: null }, source);
        if (!isTextOnlyArtwork(unit) && routing.decision.state === 'review') throw new Error(routing.facts.blockers.join('；') || routing.decision.reason);
        let correction;
        if (requested.correction) {
          const report = unit.artwork?.draft?.preprocessing.routingReport;
          const review = currentArtworkReview(unit);
          const baseRunId = review?.sha256 ?? report?.runId;
          if (!baseRunId || baseRunId !== requested.correction.baseRunId || !unit.artwork?.url) throw new Error('当前图案已变化，请刷新后重新选择问题');
          const recorded = report && !review ? await readArtworkRoutingReport(report.runId) : undefined;
          const ids = new Set(requested.correction.issueIds);
          const issues = artworkCorrectionIssues(recorded, review ?? undefined).filter(issue => ids.has(issue.id));
          if (issues.length !== ids.size) throw new Error('选中的核对问题不属于当前图案');
          correction = { baseRunId, url: unit.artwork.url, issues };
        }
        const queued = await enqueueArtworkJob({ unit, source, requirementContract: preflight.contract, ...(correction ? { correction } : {}), ...(sharedArtworkForUnit(state, unit.id)
          ? { sharedSnapshot: productionSharedSnapshot(state, unit.id) } : {}) }, productionArtworkSnapshot(unit, source));
        results.push({ unitId: unit.id, ...queued });
      } catch (error) { results.push({ unitId: requested.unitId, error: error instanceof Error ? error.message : String(error) }); }
    }
    return NextResponse.json({ results, ...await readArtworkJobs() }, { status: 202 });
  } catch (error) { return failure(error); }
}
