import { publicAnalysisProposal } from '@/lib/artwork-analysis-proposal';
import { NextResponse } from 'next/server';
import { productionUser, usesProductionCloud, productionStateKey } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { readArtworkJobs } from '@/lib/server/artwork-job-store';
import { catalogDatabase } from '@/lib/server/catalog-database';
import { preflightArtworkUnit } from '@/lib/server/artwork-preflight';
import { WORKWEAR_LOGIC_VERSION, safeErrorText, isActiveSourceStatus, recoveryForJob, artworkBusinessStep } from '@/lib/artwork-reliability';
import { WPS_COMPOSITOR_VERSION } from '@/lib/wps-production';
import { productionRenderInputKey } from '@/lib/production-render-outcome';
import type { WorkwearDiagnostics, DiagnosticOrder } from '@/lib/workwear-diagnostics';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const localUrl = (url?: string | null) => typeof url === 'string' && /^\/api\/(?:production-files|catalog\/files)\/[\da-f-]+(?:\?|$)/u.test(url) ? url : null;
/** Intentionally bypasses old GET's after-response rendering/cleanup; this route only reads. */
export async function GET(request: Request) {
  try {
    await productionUser(request);
    const state = await readWpsProductionState();
    const warnings: string[] = ['以下是服务器已同步快照，不是本次实时WPS读取。开始制作和重新分析时会再向WPS核对。'];
    const jobs = await readArtworkJobs().catch(error => { warnings.push(`后台记录读取未完成：${safeErrorText(error)}`); return { enabled: false, workerOnline: false, jobs: [] }; });
    let observed: WorkwearDiagnostics['worker']['lastObservedExecutionBuild'] = null;
    if (usesProductionCloud()) try {
      const result = await catalogDatabase().query("SELECT input->'executionBuild' AS build,updated_at FROM artwork_jobs WHERE state_key=$1 AND input ? 'executionBuild' ORDER BY updated_at DESC LIMIT 1", [productionStateKey()]);
      const row = result.rows[0];
      if (row?.build?.logicVersion) observed = { logicVersion: row.build.logicVersion, commit: row.build.commit ?? null, observedAt: new Date(row.updated_at).toISOString() };
    } catch (error) { warnings.push(`后台版本记录读取未完成：${safeErrorText(error)}`); }
    const active = state.records.filter(record => isActiveSourceStatus(record.source.wpsSource?.status));
    const query = new URL(request.url).searchParams;
    const selected = query.get('recordId') ? active.filter(record => record.source.recordId === query.get('recordId')) : active;
    const orders: DiagnosticOrder[] = selected.map(record => {
      const units = state.units.filter(unit => unit.sourceRecordId === record.source.recordId);
      return { id: record.source.recordId, customer: record.source.customerId, status: record.source.wpsSource?.status ?? '未知', requirement: record.source.requirementText,
        needsAnalysis: !units.length, units: units.map(unit => {
          let preflight: ReturnType<typeof preflightArtworkUnit> | null = null, error: string | null = null;
          try { preflight = preflightArtworkUnit(unit, record.source, 'artwork'); } catch (caught) { error = safeErrorText(caught); }
          const job = jobs.jobs.find(item => item.unitId === unit.id);
          return { id: unit.id, garmentLabel: unit.garmentLabel, placement: unit.placement?.key ?? '未确定位置', state: unit.status,
            analysisCurrent: unit.analysisLogicVersion === WORKWEAR_LOGIC_VERSION,
            artwork: unit.artwork ? { url: localUrl(unit.artwork.url), sha256: unit.artwork.validation.sha256, confirmed: !!unit.gateB } : null,
            blockers: error ? [error] : preflight?.blockers ?? [], garmentIssue: preflight?.garmentIssue ?? null, inputs: preflight?.contract.inputs ?? [],
            job: job ? { id: job.id, status: job.status, message: safeErrorText(job.message), error: job.error ? safeErrorText(job.error) : null,
              ...(job.candidate?.cutout?.status === 'failed' ? { failedCutoutKey: job.candidate.cutout.receipt.jobKey } : {}),
              recovery: job.recovery ?? recoveryForJob(job), steps: job.steps.map(step => ({ label: step.label ?? artworkBusinessStep(step.stepKey ?? '', step.stage), status: step.status, error: step.error ? safeErrorText(step.error) : null })) } : null };
        }), versions: state.mockupVersions.filter(version => version.sourceRecordId === record.source.recordId).map(version => {
          const members = units.filter(unit => version.unitIds.includes(unit.id));
          const tracked = state.renderOutcomes?.[version.id];
          const currentTracked = tracked?.inputKey === productionRenderInputKey(version, members, WPS_COMPOSITOR_VERSION);
          const confirmed = !!version.finalConfirmation;
          const current = members.length === version.unitIds.length && (currentTracked && tracked?.status === 'ready' || confirmed && !!version.output && version.output.composeFingerprint === version.composeFingerprint);
          return { id: version.id, label: `${version.garmentLabel} ${version.variantLabel}`, current, confirmed,
            url: localUrl(currentTracked && tracked?.status === 'ready' ? tracked.url : version.output?.url),
            error: currentTracked && tracked?.error ? tracked.error : version.compositionError,
            readyPositions: members.filter(unit => !!unit.artwork).length, totalPositions: version.unitIds.length };
        }), pendingProposal: (() => { const proposal = [...(state.analysisProposals ?? [])].reverse().find(item => item.recordId === record.source.recordId && item.status === 'pending'); return proposal ? publicAnalysisProposal(proposal) : null; })() };
    });
    const payload: WorkwearDiagnostics = { generatedAt: new Date().toISOString(), sourceFreshness: 'stored-snapshot', stateUpdatedAt: state.updatedAt,
      web: { logicVersion: WORKWEAR_LOGIC_VERSION, commit: process.env.WORKWEAR_BUILD_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null },
      worker: { online: jobs.workerOnline, lastObservedExecutionBuild: observed },
      counts: { allStoredOrders: state.records.length, activeOrders: active.length, displayedOrders: orders.length, activeUnits: active.reduce((sum, record) => sum + record.unitIds.length, 0) }, orders, warnings };
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return NextResponse.json({ error: safeErrorText(error) }, { status: error instanceof CatalogHttpError ? error.status : 500 }); }
}
