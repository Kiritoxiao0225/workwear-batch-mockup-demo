import { randomUUID } from 'node:crypto';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { WpsAnalysisResult, WpsAnalysisStage, WpsAnalysisTiming } from '@/lib/wps-analysis-progress';
import { TASK_REVIEW_ANALYSIS_CACHE_VERSION as TASK_REVIEW_ANALYSIS_VERSION } from '@/lib/client/task-review-analysis-cache';
import { wpsAnalysisSnapshot } from '@/lib/wps-analysis-snapshot';
import { canAnalyzeWpsTask, wpsSourceEvidence } from '@/lib/wps-source';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { fileSha256 } from './catalog-files';
import { productionFileReferences, productionStateKey, usesProductionCloud } from './production-storage';

export const wpsAnalysisJobsEnabled = () => usesProductionCloud() && process.env.WPS_DURABLE_ANALYSIS === '1';
export type AnalysisJob = {
  id: string; save_id: string; state_key: string; record_id: string; source_hash: string; analysis_version: string;
  source_json: SourceTaskRecord; target_snapshot: string;
  status: 'queued' | 'running' | 'saving' | 'completed' | 'failed' | 'stale' | 'unknown';
  result_json: WpsAnalysisResult | null; owner: string; error: string | null;
  stage: WpsAnalysisStage | null; timings: WpsAnalysisTiming[];
};
export async function enqueueWpsAnalysis(source: SourceTaskRecord, retry = false) {
  if (!canAnalyzeWpsTask(source) || !source.requirementText.trim()) throw new Error('只解析待领取或设计中且需求非空的任务');
  return catalogTransaction(async client => {
    // Same lock ordering as production edits; take snapshots from stored state, not the live browser overlay.
    const row = (await client.query('SELECT state_jsonb FROM production_states WHERE state_key=$1 FOR SHARE', [productionStateKey()])).rows[0];
    if (!row) throw new Error('生产状态尚未初始化');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`analysis:${productionStateKey()}:${source.recordId}`]);
    const state = row.state_jsonb;
    const hash = fileSha256(wpsSourceEvidence(source));
    const saved = state.records.find((record: { source: SourceTaskRecord; unitIds: string[] }) => record.source.recordId === source.recordId && record.unitIds.length && wpsSourceEvidence(record.source) === wpsSourceEvidence(source));
    // A new model/prompt version never silently reinterprets already parsed or manually edited orders.
    if (saved) return { id: null, status: 'completed' as const };
    const active = (await client.query("SELECT * FROM wps_analysis_jobs WHERE state_key=$1 AND record_id=$2 AND status IN ('queued','running','saving','unknown') FOR UPDATE", [productionStateKey(), source.recordId])).rows[0] as AnalysisJob | undefined;
    if (active && active.source_hash !== hash) {
      if (active.status === 'queued' || active.status === 'unknown') await client.query("UPDATE wps_analysis_jobs SET status='stale',error='WPS 需求已变化',updated_at=now() WHERE id=$1", [active.id]);
      else return { id: active.id, status: active.status };
    }
    const existing = (await client.query('SELECT * FROM wps_analysis_jobs WHERE state_key=$1 AND record_id=$2 AND source_hash=$3 AND analysis_version=$4 FOR UPDATE', [productionStateKey(), source.recordId, hash, TASK_REVIEW_ANALYSIS_VERSION])).rows[0] as AnalysisJob | undefined;
    if (existing) {
      if (existing.status === 'completed') {
        // A reverted WPS requirement can reuse its parsed response, but is a new
        // save operation against the newly frozen production target.
        await client.query("UPDATE wps_analysis_jobs SET status='queued',save_id=$2,target_snapshot=$3,source_json=$4,error=NULL,updated_at=now() WHERE id=$1", [existing.id, randomUUID(), wpsAnalysisSnapshot(state, source.recordId), source]);
        return { id: existing.id, status: 'queued' as const };
      }
      if (retry && ['failed', 'stale', 'unknown'].includes(existing.status)) {
        // Keep parsed responses only if their original target is still current.
        const target = wpsAnalysisSnapshot(state, source.recordId);
        if (existing.result_json && existing.target_snapshot !== target) throw new Error('解析结果对应的订单已修改，请同步后核对，不能覆盖当前图稿');
        await client.query("UPDATE wps_analysis_jobs SET status='queued',error=NULL,owner=NULL,lease_until=NULL,target_snapshot=$2,source_json=$3,updated_at=now() WHERE id=$1", [existing.id, target, source]);
        return { id: existing.id, status: 'queued' as const };
      }
      return { id: existing.id, status: existing.status };
    }
    if (active && active.source_hash === hash) return { id: active.id, status: active.status };
    const id = randomUUID();
    await client.query('INSERT INTO wps_analysis_jobs(id,state_key,record_id,source_hash,analysis_version,source_json,target_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, productionStateKey(), source.recordId, hash, TASK_REVIEW_ANALYSIS_VERSION, source, wpsAnalysisSnapshot(state, source.recordId)]);
    const ids = [...new Set(productionFileReferences(source).map(ref => ref.id))].sort();
    if (ids.length) await client.query('INSERT INTO wps_analysis_files(job_id,file_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING', [id, ids]);
    return { id, status: 'queued' as const };
  });
}
export async function readWpsAnalysisJobs() {
  if (!wpsAnalysisJobsEnabled()) return { enabled: false, workerOnline: false, jobs: [] };
  const [jobs, heartbeat] = await Promise.all([
    catalogDatabase().query(`SELECT DISTINCT ON(record_id) id,record_id,source_json,status,error,stage,timings,result_json IS NOT NULL AS parsed,updated_at
      FROM wps_analysis_jobs WHERE state_key=$1 ORDER BY record_id,updated_at DESC,created_at DESC`, [productionStateKey()]),
    catalogDatabase().query("SELECT 1 FROM production_operations WHERE operation_key LIKE $1 AND lease_until>now() LIMIT 1", [`analysis-worker:${productionStateKey()}:%`]),
  ]);
  return { enabled: true, workerOnline: Boolean(heartbeat.rowCount), jobs: jobs.rows.map(job => ({
    id: job.id as string, recordId: job.record_id as string, evidence: wpsSourceEvidence(job.source_json), status: job.status as AnalysisJob['status'],
    error: job.error as string | null, stage: job.stage as WpsAnalysisStage | null, timings: job.timings as WpsAnalysisTiming[], parsed: Boolean(job.parsed), updatedAt: job.updated_at,
  })) };
}
export async function heartbeatWpsAnalysis(owner: string) {
  await catalogDatabase().query(`INSERT INTO production_operations(operation_key,owner,lease_until) VALUES($1,$2,now()+interval '40 seconds')
    ON CONFLICT(operation_key) DO UPDATE SET lease_until=EXCLUDED.lease_until,updated_at=now()`, [`analysis-worker:${productionStateKey()}:${owner}`, owner]);
  await catalogDatabase().query("UPDATE wps_analysis_jobs SET lease_until=now()+interval '45 seconds' WHERE state_key=$1 AND owner=$2 AND status IN ('running','saving')", [productionStateKey(), owner]);
}
export async function claimWpsAnalysis(owner: string): Promise<AnalysisJob | null> {
  return catalogTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wps-analysis-dispatch'))");
    // Never automatically repeat a model call whose response may have been lost.
    await client.query("UPDATE wps_analysis_jobs SET status='unknown',error='后台中断，解析提交状态未知；请核对后手动重试',owner=NULL WHERE status='running' AND result_json IS NULL AND lease_until<=now()");
    const active = await client.query("SELECT count(*)::int AS n FROM wps_analysis_jobs WHERE status IN ('running','saving') AND lease_until>now()");
    if (active.rows[0].n >= 5) return null;
    const job = (await client.query(`SELECT * FROM wps_analysis_jobs WHERE state_key=$1 AND
      (status='queued' OR (status IN ('running','saving') AND result_json IS NOT NULL AND lease_until<=now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [productionStateKey()])).rows[0];
    if (!job) return null;
    return (await client.query("UPDATE wps_analysis_jobs SET status=CASE WHEN result_json IS NULL THEN 'running' ELSE 'saving' END,owner=$2,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 RETURNING *", [job.id, owner])).rows[0] as AnalysisJob;
  });
}
export async function storeWpsAnalysisResult(job: AnalysisJob, result: WpsAnalysisResult) {
  await catalogTransaction(async client => {
    const updated = await client.query("UPDATE wps_analysis_jobs SET result_json=$3,status='saving',updated_at=now() WHERE id=$1 AND owner=$2 AND lease_until>now() AND status='running' RETURNING id", [job.id, job.owner, result]);
    if (!updated.rowCount) throw new Error('解析任务租约已变化，结果未提交');
    const ids = [...new Set(productionFileReferences(result).map(ref => ref.id))].sort();
    if (ids.length) await client.query('INSERT INTO wps_analysis_files(job_id,file_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING', [job.id, ids]);
  });
}
export async function finishWpsAnalysis(job: AnalysisJob, status: AnalysisJob['status'], error?: string) {
  await catalogDatabase().query('UPDATE wps_analysis_jobs SET status=$3,error=$4,owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND owner=$2', [job.id, job.owner, status, error ?? null]);
}
