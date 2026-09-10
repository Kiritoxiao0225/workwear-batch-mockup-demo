import { setTimeout as delay } from 'node:timers/promises';
import { WPS_ANALYSIS_REQUEST_TIMEOUT_MS } from '@/lib/wps-analysis-progress';
import { assertWpsAnalysisSnapshot } from '@/lib/wps-analysis-snapshot';
import { ProductionArtworkConflictError } from '@/lib/production-artwork-snapshot';
import { canAnalyzeWpsTask, wpsSourceEvidence } from '@/lib/wps-source';
import { analyzeSourceTaskRecords } from './ark-task-review';
import { catalogDatabase } from './catalog-database';
import { fileSha256 } from './catalog-files';
import { completedProductionSave } from './production-cloud-state';
import { finishProductionSave } from './production-post-save';
import { persistProductionReferences, productionStateKey } from './production-storage';
import { readWpsProductionState } from './wps-production-store';
import { listWpsSourceTaskRecords } from './wps-dbsheet';
import { persistWpsSourceOrder } from './wps-source-order';
import { enqueueWpsAnalysis, finishWpsAnalysis, storeWpsAnalysisResult, type AnalysisJob } from './wps-analysis-jobs';
import { saveWpsAnalysis, verifyWpsAnalysisSources } from './wps-analysis-save';
import { WpsAnalysisTrace } from './wps-analysis-trace';

const services = { analyze: analyzeSourceTaskRecords, sources: listWpsSourceTaskRecords, verify: verifyWpsAnalysisSources, previews: finishProductionSave };
export async function processWpsAnalysis(job: AnalysisJob, dependencies = services) {
  if (job.state_key !== productionStateKey()) throw new Error('解析任务不属于当前生产环境');
  const receipt = { id: job.save_id, hash: fileSha256(JSON.stringify([job.source_hash, job.analysis_version, job.target_snapshot])) };
  // Serialize progress writes; they must finish before ownership is released.
  let progressWrites = Promise.resolve();
  const trace = new WpsAnalysisTrace(() => {
    const stage = trace.stage, timings = [...trace.timings];
    progressWrites = progressWrites.then(async () => {
      await catalogDatabase().query('UPDATE wps_analysis_jobs SET stage=$3,timings=$4 WHERE id=$1 AND owner=$2', [job.id, job.owner, stage, timings]);
    }).catch(() => {});
  });
  let parsedButUnsaved = false;
  try {
    if (await completedProductionSave(receipt)) { await finishWpsAnalysis(job, 'completed'); return; }
    const current = await readWpsProductionState();
    assertWpsAnalysisSnapshot(current, job.record_id, job.target_snapshot);
    await dependencies.verify([job.source_json]);
    let result = job.result_json;
    if (!result) {
      const { records } = await dependencies.sources({ recordIds: [job.record_id] });
      const source = records.find(source => source.recordId === job.record_id);
      if (!source || wpsSourceEvidence(source) !== wpsSourceEvidence(job.source_json)) throw new ProductionArtworkConflictError('找不到 WPS 原始任务');
      // The model service also has its original timeout and inspection retry rules.
      result = await dependencies.analyze([source], { trace, signal: AbortSignal.timeout(WPS_ANALYSIS_REQUEST_TIMEOUT_MS) });
      if (!result.reviews?.some(review => review.source.recordId === job.record_id && review.units.length)) throw new Error('未解析出可制作位置，请检查需求后重试');
      parsedButUnsaved = true;
      result = await persistProductionReferences(result);
      for (let attempt = 0; ; attempt++) {
        try { await storeWpsAnalysisResult(job, result); break; }
        catch (error) { if (attempt >= 2) throw error; await delay(500 * (attempt + 1)); }
      }
      parsedButUnsaved = false;
    }
    await saveWpsAnalysis(result.reviews, { [job.record_id]: job.target_snapshot }, receipt, dependencies.verify);
    await progressWrites;
    await finishWpsAnalysis(job, 'completed');
    // Rendering is independent of the paid parsing result and its saved receipt.
    await dependencies.previews().catch(error => console.warn('[wps-analysis-preview]', error instanceof Error ? error.name : 'Error'));
  } catch (error) {
    await progressWrites;
    await finishWpsAnalysis(job, parsedButUnsaved ? 'unknown' : error instanceof ProductionArtworkConflictError ? 'stale' : 'failed',
      parsedButUnsaved ? '模型已返回，但结果未能持久化；未自动重新解析，手动重试可能再次调用模型' : error instanceof Error ? error.message : String(error));
  }
}

/** Global discovery lease avoids polling WPS once per browser/worker replica. */
export async function discoverWpsAnalysis(owner: string) {
  const lease = await catalogDatabase().query(`INSERT INTO production_operations(operation_key,owner,lease_until) VALUES($1,$2,now()+interval '2 minutes')
    ON CONFLICT(operation_key) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until,updated_at=now()
    WHERE production_operations.lease_until<=now() RETURNING owner`, [`analysis-discovery:${productionStateKey()}`, owner]);
  if (!lease.rowCount) return;
  try {
    const sync = await listWpsSourceTaskRecords({ activeOnly: true, downloadMaterials: false });
    const records = await persistWpsSourceOrder(sync.records);
    for (const source of records.filter(source => canAnalyzeWpsTask(source) && source.requirementText.trim())) await enqueueWpsAnalysis(source);
  } finally {
    await catalogDatabase().query("UPDATE production_operations SET lease_until=now()+interval '30 seconds' WHERE operation_key=$1 AND owner=$2", [`analysis-discovery:${productionStateKey()}`, owner]);
  }
}
