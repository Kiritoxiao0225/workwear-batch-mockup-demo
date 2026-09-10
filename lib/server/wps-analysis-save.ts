import type { SourceTaskRecord, TaskReview } from '@/lib/batch-task-review';
import { assertWpsAnalysisSnapshot } from '@/lib/wps-analysis-snapshot';
import { canAnalyzeWpsTask, wpsSourceEvidence } from '@/lib/wps-source';
import { ProductionArtworkConflictError } from '@/lib/production-artwork-snapshot';
import { upsertTaskReviews } from '@/lib/wps-production';
import { listWpsSourceTaskRecords } from './wps-dbsheet';
import { prepareCatalogReviews } from './wps-production-garments';
import { persistProductionReferences, usesProductionCloud } from './production-storage';
import { mutateWpsProductionState, readWpsProductionState } from './wps-production-store';

export async function verifyWpsAnalysisSources(sources: SourceTaskRecord[]) {
  const { records } = await listWpsSourceTaskRecords({ recordIds: sources.map(source => source.recordId), downloadMaterials: false });
  for (const source of sources) {
    const current = records.find(record => record.recordId === source.recordId);
    if (!current || !canAnalyzeWpsTask(current) || wpsSourceEvidence(current) !== wpsSourceEvidence(source))
      throw new ProductionArtworkConflictError('WPS 原文、附件或任务状态已变化，请同步后重试解析');
  }
}
export async function saveWpsAnalysis(reviews: TaskReview[], snapshots: Record<string, string>, receipt?: { id: string; hash: string }, verify = verifyWpsAnalysisSources) {
  for (const review of reviews) if (typeof snapshots?.[review.source.recordId] !== 'string')
    throw new ProductionArtworkConflictError('缺少解析开始时的订单快照，请刷新后重新解析');
  const prepared = await prepareCatalogReviews(reviews);
  const persisted = usesProductionCloud() ? await persistProductionReferences(prepared) : prepared;
  // Check live WPS after slow image preparation, immediately before the CAS save.
  await verify(reviews.map(review => review.source));
  const current = await readWpsProductionState();
  return mutateWpsProductionState(current.revision, state => upsertTaskReviews(state, persisted), state => {
    for (const review of reviews) assertWpsAnalysisSnapshot(state, review.source.recordId, snapshots[review.source.recordId]);
  }, receipt);
}
