import { artworkBusinessStep, recoveryForJob, safeErrorText, assertActiveSourceStatus } from '@/lib/artwork-reliability';
import { randomUUID } from 'node:crypto';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { productionFileReferences, productionStateKey, usesProductionCloud } from './production-storage';
import type { ProductionUnit } from '@/lib/wps-production';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ArtworkJobsResponse, ArtworkJobStatus } from '@/lib/artwork-jobs';
import { assertProductionArtworkSnapshot, assertProductionSharedSnapshot } from '@/lib/production-artwork-snapshot';
import { artworkInspectionFailure } from './artwork-network-error';
import { ARTWORK_EDIT_INSPECTION_VERSION } from '@/lib/artwork-model-edits';
import { readCloudProductionState } from './production-cloud-state';

export const artworkJobsEnabled = () => usesProductionCloud() && process.env.ARTWORK_DURABLE_JOBS === '1';
export type ArtworkJobInput = { cutoutRecovery?: { requestId: string; failedKey: string; sourceSha256: string; mode: import('@/lib/artwork-cutout').ArtworkCutoutMode; requestedAt: string }; cutoutRecoveryHistory?: unknown[]; requirementContract?: import('@/lib/artwork-reliability').ArtworkRequirementContract; executionBuild?: { logicVersion: string; commit: string | null }; correction?: { baseRunId: string; url: string; issues: import('@/lib/artwork-correction').ArtworkCorrectionIssue[] }; unit: ProductionUnit; source: SourceTaskRecord; sharedSnapshot?: string };
export type ArtworkJob = { id: string; state_key: string; unit_id: string; snapshot: string; input: ArtworkJobInput; status: ArtworkJobStatus; owner: string; attempt: number };
export async function retainJobFiles(client: CatalogQueryClient, id: string, value: unknown) {
  const ids = [...new Set(productionFileReferences(value).map(ref => ref.id))].sort();
  if (ids.length) await client.query('INSERT INTO artwork_job_files(job_id,file_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING', [id, ids]);
}
export async function enqueueArtworkJob(input: ArtworkJobInput, snapshot: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = input.sharedSnapshot ? await readCloudProductionState() : null;
    const result = await catalogTransaction(async client => {
      const stored = (await client.query('SELECT revision FROM production_states WHERE state_key=$1 FOR SHARE', [productionStateKey()])).rows[0];
      if (input.sharedSnapshot && !stored) throw new Error('共用图稿生产状态不存在');
      if (state && stored && input.sharedSnapshot) {
        if (Number(stored.revision) !== state.revision) return null;
        assertProductionArtworkSnapshot(state, input.unit.id, snapshot);
        assertProductionSharedSnapshot(state, input.unit.id, input.sharedSnapshot);
      }
      // Serialize same-unit submissions from separate browsers and workers.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`artwork:${productionStateKey()}:${input.unit.id}`]);
      const existing = (await client.query("SELECT * FROM artwork_jobs WHERE state_key=$1 AND unit_id=$2 AND status IN ('queued','running','unknown')", [productionStateKey(), input.unit.id])).rows[0];
      if (existing) {
        const sameCorrection = existing.input.correction?.baseRunId === input.correction?.baseRunId && existing.input.correction?.url === input.correction?.url
          && (existing.input.correction?.issues.map((issue: { id: string }) => issue.id).sort().join(',') ?? '') === (input.correction?.issues.map(issue => issue.id).sort().join(',') ?? '');
        if (!sameCorrection || existing.snapshot !== snapshot || existing.input.sharedSnapshot !== input.sharedSnapshot) throw new Error('该图案已有后台任务，要求发生变化，请等待原任务结束后再制作');
        return { id: existing.id as string, existing: true };
      }
      if (input.correction) {
        const previous = (await client.query("SELECT id FROM artwork_jobs WHERE state_key=$1 AND unit_id=$2 AND input->'correction'=$3::jsonb ORDER BY created_at DESC LIMIT 1", [productionStateKey(), input.unit.id, input.correction])).rows[0];
        if (previous) return { id: previous.id as string, existing: true };
      }
      const id = randomUUID();
      await client.query("INSERT INTO artwork_jobs(id,state_key,unit_id,snapshot,input,status) VALUES($1,$2,$3,$4,$5,'queued')", [id, productionStateKey(), input.unit.id, snapshot, input]);
      await retainJobFiles(client, id, input);
      return { id, existing: false };
    });
    if (result) return result;
  }
  throw new Error('图案正在更新，尚未加入制作队列，请稍后重试');
}
export async function readArtworkJobs(): Promise<ArtworkJobsResponse> {
  if (!artworkJobsEnabled()) return { enabled: false, workerOnline: false, jobs: [] };
  const [jobs, workers] = await Promise.all([
    catalogDatabase().query(`SELECT j.id,j.unit_id,j.status,j.message,j.error,j.candidate,j.created_at,j.updated_at,
      (j.status='review' AND j.candidate->>'stage'='edit-review'
       AND EXISTS(SELECT 1 FROM artwork_run_records r WHERE r.state_key=j.state_key AND r.run_id::text=j.candidate->>'runId'
         AND r.kind='generation' AND NOT (r.record_json ? 'component'))
       AND NOT EXISTS(SELECT 1 FROM artwork_job_steps s WHERE s.job_id=j.id AND s.stage='inspection' AND s.status='completed'
         AND s.result->>'inspectionVersion'=$2)) AS recheck_available,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('stepKey',s.step_key,'stage',s.stage,'status',s.status,'error',s.error,'durationMs',
       CASE WHEN s.finished_at IS NULL THEN NULL ELSE ROUND(EXTRACT(EPOCH FROM(s.finished_at-s.started_at))*1000) END) ORDER BY s.started_at)
       FROM artwork_job_steps s WHERE s.job_id=j.id),'[]'::jsonb) AS steps
      FROM artwork_jobs j WHERE j.state_key=$1 AND (j.status IN ('queued','running','unknown') OR
        (j.created_at>now()-interval '7 days' AND j.id IN (SELECT DISTINCT ON(unit_id) id FROM artwork_jobs WHERE state_key=$1 ORDER BY unit_id,created_at DESC)))
      ORDER BY j.created_at DESC`, [productionStateKey(), ARTWORK_EDIT_INSPECTION_VERSION]),
    catalogDatabase().query("SELECT 1 FROM artwork_workers WHERE state_key=$1 AND heartbeat_at>now()-interval '35 seconds' LIMIT 1", [productionStateKey()]),
  ]);
  return { enabled: true, workerOnline: !!workers.rowCount, jobs: jobs.rows.map(row => {
    const steps = (row.steps as ArtworkJobsResponse['jobs'][number]['steps']).map(step => ({ ...step,
      label: artworkBusinessStep(step.stepKey ?? '', step.stage),
      error: step.error ? safeErrorText(step.stage === 'inspection' ? artworkInspectionFailure(new Error(step.error)) : step.error) : null }));
    const inspectionError = steps.find(step => step.stage === 'inspection' && step.status === 'failed' && step.error)?.error;
    return { id: row.id, unitId: row.unit_id, status: row.status, message: row.message, recheckAvailable: Boolean(row.recheck_available),
      recovery: recoveryForJob({ status: row.status, candidate: row.candidate, steps, error: row.error, recheckAvailable: Boolean(row.recheck_available) }),
      error: row.status === 'failed' && row.candidate?.stage === 'edit-review' && inspectionError
        ? `图案已生成，${inspectionError}这张图还没保存成品，可复用已生成图片继续核对。` : row.error,
      candidate: row.candidate, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), steps };
  }) };
}
export async function claimArtworkJob(owner: string): Promise<ArtworkJob | null> {
  return catalogTransaction(async client => {
    const found = (await client.query(`SELECT * FROM artwork_jobs WHERE state_key=$1 AND (status='queued' OR (status='running' AND lease_until<now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [productionStateKey()])).rows[0];
    if (!found) return null;
    // A paid generation whose response was lost cannot be submitted a second time.
    const unknown = await client.query("SELECT 1 FROM artwork_job_steps WHERE job_id=$1 AND (stage='generation' OR step_key LIKE 'mediakit:/api/v1/tools-sync/enhance-image:%') AND status IN ('running','unknown')", [found.id]);
    if (unknown.rowCount) {
      await client.query("UPDATE artwork_jobs SET status='unknown',message='付费处理返回结果不确定，请核对原任务，避免重复扣费',error='后台中断前的生图或增强尚无已保存回执',owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [found.id]);
      return null;
    }
    const claimed = await client.query("UPDATE artwork_jobs SET status='running',owner=$2,lease_until=now()+interval '45 seconds',attempt=attempt+1,message='正在读取素材',error=NULL,updated_at=now() WHERE id=$1 RETURNING *", [found.id, owner]);
    return claimed.rows[0] as ArtworkJob;
  });
}
export async function assertArtworkJobOwner(client: CatalogQueryClient, job: Pick<ArtworkJob, 'id' | 'owner'>) {
  const result = await client.query("SELECT 1 FROM artwork_jobs WHERE id=$1 AND owner=$2 AND status='running' AND lease_until>now() FOR UPDATE", [job.id, job.owner]);
  if (!result.rowCount) throw new Error('后台任务租约已失效，已停止此处理进程');
}
export async function heartbeatArtworkWorker(owner: string) {
  await catalogTransaction(async client => {
    await client.query("INSERT INTO artwork_stage_slots(stage,slot) SELECT stage,generate_series(1,capacity) FROM (VALUES ('generation',6),('cutout',2),('quality',1),('inspection',2),('processing',2)) AS limits(stage,capacity) ON CONFLICT DO NOTHING");
    await client.query('INSERT INTO artwork_workers(id,state_key) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()', [owner, productionStateKey()]);
    await client.query("UPDATE artwork_jobs SET lease_until=now()+interval '45 seconds' WHERE owner=$1 AND status='running' AND lease_until>now()", [owner]);
    await client.query("UPDATE artwork_stage_slots SET lease_until=now()+interval '5 minutes' WHERE owner=$1 AND job_id IN (SELECT id FROM artwork_jobs WHERE owner=$1 AND status='running' AND lease_until>now())", [owner]);
  });
}
export async function updateArtworkJob(job: ArtworkJob, status: ArtworkJobStatus, message: string, error: string | null = null, candidate: unknown = null) {
  await catalogTransaction(async client => {
    await assertArtworkJobOwner(client, job);
    await retainJobFiles(client, job.id, candidate);
    await client.query('UPDATE artwork_jobs SET status=$3,message=$4,error=$5,candidate=$6,updated_at=now() WHERE id=$1 AND owner=$2', [job.id, job.owner, status, message, error, candidate]);
  });
}
export async function changeArtworkJob(id: string, action: 'cancel' | 'retry') {
  return catalogTransaction(async client => {
    const job = (await client.query('SELECT * FROM artwork_jobs WHERE id=$1 AND state_key=$2 FOR UPDATE', [id, productionStateKey()])).rows[0];
    if (!job) throw new Error('找不到后台任务');
    if (action === 'cancel') {
      if (job.status !== 'queued') throw new Error('只可取消尚未开始的任务');
      await client.query("UPDATE artwork_jobs SET status='cancelled',message='已取消排队',updated_at=now() WHERE id=$1", [id]);
    } else {
      if (job.input?.source?.wpsSource) assertActiveSourceStatus(job.input.source.wpsSource.status);
      const storedSteps = (await client.query('SELECT stage,status,error,step_key AS "stepKey" FROM artwork_job_steps WHERE job_id=$1 ORDER BY started_at', [id])).rows;
      const recovery = recoveryForJob({ status: job.status, candidate: job.candidate, error: job.error, steps: storedSteps as Array<{ stage: string; status: string; error?: string }>, recheckAvailable: job.status === 'review' });
      if (recovery.action === 'changeCutoutMethod') throw new Error(recovery.reason + '；请查看保留的候选，选择其他抠图方式或上传处理好的图案，不要重复普通续做');
      if (job.status === 'review' && job.candidate?.stage === 'edit-review') {
        const receipt = (await client.query("SELECT record_json FROM artwork_run_records WHERE state_key=$1 AND run_id::text=$2 AND kind='generation'", [productionStateKey(), job.candidate.runId])).rows[0]?.record_json;
        const inspected = await client.query("SELECT 1 FROM artwork_job_steps WHERE job_id=$1 AND stage='inspection' AND status='completed' AND result->>'inspectionVersion'=$2", [id, ARTWORK_EDIT_INSPECTION_VERSION]);
        if (!receipt || receipt.component || inspected.rowCount) throw new Error('当前规则已核对或这张图不是完整图案，请查看具体差异后修改要求；无需重复核对');
      } else if (job.status !== 'failed') throw new Error('仅处理失败或尚未按新规则核对的任务可继续');
      const unknown = await client.query("SELECT 1 FROM artwork_job_steps WHERE job_id=$1 AND status IN ('unknown','running') AND (stage='generation' OR step_key LIKE 'mediakit:/api/v1/tools-sync/enhance-image:%')", [id]);
      if (unknown.rowCount) throw new Error('生图结果不确定，不能自动再次提交');
      await client.query("UPDATE artwork_jobs SET status='queued',message='已排队，从未完成步骤继续',error=NULL,updated_at=now() WHERE id=$1", [id]);
    }
    return job as ArtworkJob;
  });
}
