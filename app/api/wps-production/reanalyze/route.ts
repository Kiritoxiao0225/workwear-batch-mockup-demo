import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { readWpsProductionState, mutateWpsProductionState } from '@/lib/server/wps-production-store';
import { analyzeSourceTaskRecords } from '@/lib/server/ark-task-review';
import { verifyWpsAnalysisSources } from '@/lib/server/wps-analysis-save';
import { readArtworkJobs } from '@/lib/server/artwork-job-store';
import { updateProductionPlan, type ProductionPlanPatch } from '@/lib/wps-production';
import { assertProductionArtworkSnapshot, productionArtworkSnapshot, ProductionArtworkConflictError } from '@/lib/production-artwork-snapshot';
import { canonicalJson, editableRequirements, requirementDiff, WORKWEAR_LOGIC_VERSION, isActiveSourceStatus, safeErrorText } from '@/lib/artwork-reliability';
import { publicAnalysisProposal, type ArtworkAnalysisProposal } from '@/lib/artwork-analysis-proposal';
import { wpsSourceEvidence } from '@/lib/wps-source';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), recordId: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('apply'), proposalId: z.string().uuid(), unitIds: z.array(z.string().min(1).max(500)).min(1).max(100) }).strict(),
]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const matchKey = (garment: string, variant: string, placement: string | null | undefined) => canonicalJson([garment.trim(), variant.trim(), placement ?? null]);
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const input = schema.parse(await request.json());
    const before = await readWpsProductionState();
    if (input.action === 'preview') {
      const record = before.records.find(item => item.source.recordId === input.recordId);
      if (!record || !isActiveSourceStatus(record.source.wpsSource?.status)) throw new Error('只能重新核对当前待领取/设计中的订单');
      const originals = before.units.filter(unit => unit.sourceRecordId === input.recordId);
      if (!originals.length) throw new Error('该订单尚未解析，请先在完整编辑台分析新增订单');
      const snapshots = new Map(originals.map(unit => [unit.id, productionArtworkSnapshot(unit, record.source)]));
      await verifyWpsAnalysisSources([record.source]);
      // An explicit click invokes one analysis, not artwork generation or automatic saves of the result.
      const analyzed = await analyzeSourceTaskRecords([record.source]);
      const review = analyzed.reviews.find(item => item.source.recordId === input.recordId);
      if (!review) throw new Error('分析结果没有对应本订单，旧要求未修改');
      const proposal: ArtworkAnalysisProposal = { id: randomUUID(), recordId: input.recordId,
        createdAt: new Date().toISOString(), logicVersion: WORKWEAR_LOGIC_VERSION,
        sourceEvidence: digest(wpsSourceEvidence(record.source)), status: 'pending', changes: [], unmatched: [],
        warnings: ['这是候选差异，不会自动覆盖人工修改或已确认图案。只选择确认需要更新的位置。',
          '新增、缺失或不能唯一匹配的位置不会猜测归属；请在完整编辑台核对。'] };
      const matched = new Set<string>();
      for (const candidate of review.units) {
        const key = matchKey(candidate.garmentLabel, candidate.variantLabel, candidate.placement);
        const possibilities = originals.filter(unit => matchKey(unit.garmentLabel, unit.variantLabel, unit.placement?.key) === key);
        const candidatesAtKey = review.units.filter(unit => matchKey(unit.garmentLabel, unit.variantLabel, unit.placement) === key);
        if (possibilities.length !== 1 || candidatesAtKey.length !== 1) {
          proposal.unmatched.push(`${candidate.garmentLabel}/${candidate.variantLabel}/${candidate.placement ?? '位置未定'}：不能唯一对应旧位置，未应用`); continue;
        }
        const unit = possibilities[0]; matched.add(unit.id);
        const patch: ProductionPlanPatch = { materialId: candidate.logo.materialId,
          referenceMaterialIds: candidate.referenceMaterialIds, sourceScope: candidate.sourceScope,
          textMode: candidate.textMode, exactText: candidate.exactText, instruction: candidate.instruction,
          layoutNote: candidate.layoutNote, generationPrompt: candidate.generationPrompt ?? '',
          fontReference: unit.fontReference?.origin === 'manual' ? unit.fontReference : candidate.fontReference ?? null };
        const differences = requirementDiff(editableRequirements(unit), editableRequirements(patch));
        proposal.changes.push({ unitId: unit.id, label: `${unit.garmentLabel} / ${unit.placement?.key ?? ''}`,
          snapshot: snapshots.get(unit.id)!, patch, differences });
      }
      for (const unit of originals) if (!matched.has(unit.id)) proposal.unmatched.push(`${unit.garmentLabel}/${unit.placement?.key ?? ''}：新分析未唯一返回本位置，旧位置原样保留`);
      await verifyWpsAnalysisSources([record.source]);
      const current = await readWpsProductionState();
      await mutateWpsProductionState(current.revision, state => ({ ...state,
        analysisProposals: [...(state.analysisProposals ?? []), proposal], revision: state.revision + 1, updatedAt: new Date().toISOString(),
      }), state => { for (const [id, snapshot] of snapshots) assertProductionArtworkSnapshot(state, id, snapshot); });
      return NextResponse.json({ proposal: publicAnalysisProposal(proposal), artworkGenerationCalls: 0, applied: false }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const proposal = before.analysisProposals?.find(item => item.id === input.proposalId);
    if (!proposal) throw new Error('找不到差异方案');
    if (proposal.status === 'applied') return NextResponse.json({ proposal: publicAnalysisProposal(proposal), applied: true, existing: true });
    const record = before.records.find(item => item.source.recordId === proposal.recordId);
    if (!record || digest(wpsSourceEvidence(record.source)) !== proposal.sourceEvidence) throw new Error('原文或素材已变化，请重新获取差异');
    await verifyWpsAnalysisSources([record.source]);
    const ids = new Set(input.unitIds);
    const selected = proposal.changes.filter(change => ids.has(change.unitId));
    if (selected.length !== ids.size) throw new Error('选中的位置不属于此差异方案');
    const jobs = await readArtworkJobs();
    if (jobs.jobs.some(job => ids.has(job.unitId) && ['queued', 'running', 'unknown'].includes(job.status))) throw new Error('所选位置仍有后台任务，请先等待结束或核实未知提交');
    const now = new Date().toISOString();
    await mutateWpsProductionState(before.revision, state => {
      const stored = state.analysisProposals?.find(item => item.id === proposal.id);
      if (stored?.status !== 'pending') throw new ProductionArtworkConflictError('此差异方案已处理，请刷新');
      let next = state;
      for (const change of selected) {
        const unit = next.units.find(item => item.id === change.unitId)!;
        if (unit.sharedArtworkId) throw new Error('该位置使用共用图稿，请先在完整编辑台拆出或核对整个共享组；不会静默修改其他位置');
        if (next.mockupVersions.some(version => version.unitIds.includes(unit.id) && version.finalConfirmation)) throw new Error('已确认成品不在原版本直接覆盖，请另建版本');
        if (change.differences.length) next = updateProductionPlan(next, unit.id, { ...change.patch, routeEvidence: '人工确认新分析要求' });
        next = { ...next, units: next.units.map(item => item.id === unit.id ? { ...item, analysisLogicVersion: WORKWEAR_LOGIC_VERSION } : item) };
      }
      return { ...next, revision: Math.max(next.revision, state.revision + 1), updatedAt: now,
        analysisProposals: next.analysisProposals?.map(item => item.id === proposal.id ? { ...item, status: 'applied' as const, appliedAt: now } : item) };
    }, state => { for (const change of selected) assertProductionArtworkSnapshot(state, change.unitId, change.snapshot); });
    return NextResponse.json({ applied: true, unitIds: [...ids], artworkGenerationCalls: 0 });
  } catch (error) {
    return NextResponse.json({ error: safeErrorText(error) }, { status: error instanceof CatalogHttpError ? error.status : error instanceof ProductionArtworkConflictError ? 409 : 400 });
  }
}
