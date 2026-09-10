import { randomUUID } from 'node:crypto';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { productionFileReferences, productionStateKey, usesProductionCloud } from './production-storage';
import type { ProductionUnit } from '@/lib/wps-production';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ArtworkJobsResponse, ArtworkJobStatus } from '@/lib/artwork-jobs';

export const artworkJobsEnabled = () => usesProductionCloud() && process.env.ARTWORK_DURABLE_JOBS === '1';
export type ArtworkJobInput = { unit: ProductionUnit; source: SourceTaskRecord };
export type ArtworkJob = { id: string; state_key: string; unit_id: string; snapshot: string; input: ArtworkJobInput; status: ArtworkJobStatus; owner: string; attempt: number };
export async function retainJobFiles(client: CatalogQueryClient, id: string, value: unknown) {
  const ids = [...new Set(productionFileReferences(value).map(ref => ref.id))].sort();
  if (ids.length) await client.query('INSERT INTO artwork_job_files(job_id,file_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING', [id, ids]);
}
export async function enqueueArtworkJob(input: ArtworkJobInput, snapshot: string) {
  return catalogTransaction(async client => {
    // Serialize same-unit submissions from separate browsers and workers.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`artwork:${productionStateKey()}:${input.unit.id}`]);
    const existing = (await client.query("SELECT * FROM artwork_jobs WHERE state_key=$1 AND unit_id=$2 AND status IN ('queued','running','unknown')", [productionStateKey(), input.unit.id])).rows[0];
    if (existing) {
      if (existing.snapshot !== snapshot) throw new Error('该图案已有后台任务，要求发生变化，请等待原任务结束后再制作');
      return { id: existing.id as string, existing: true };
    }
    const id = randomUUID();
    await client.query("INSERT INTO artwork_jobs(id,state_key,unit_id,snapshot,input,status) VALUES($1,$2,$3,$4,$5,'queued')", [id, productionStateKey(), input.unit.id, snapshot, input]);
    await retainJobFiles(client, id, input);
    return { id, existing: false };
  });
}
export async function readArtworkJobs(): Promise<ArtworkJobsResponse> {
  if (!artworkJobsEnabled()) return { enabled: false, workerOnline: false, jobs: [] };
  const [jobs, workers] = await Promise.all([
    catalogDatabase().query(`SELECT j.id,j.unit_id,j.status,j.message,j.error,j.candidate,j.created_at,j.updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('stage',s.stage,'status',s.status,'durationMs',
       CASE WHEN s.finished_at IS NULL THEN NULL ELSE ROUND(EXTRACT(EPOCH FROM(s.finished_at-s.started_at))*1000) END) ORDER BY s.started_at)
       FROM artwork_job_steps s WHERE s.job_id=j.id),'[]'::jsonb) AS steps
      FROM artwork_jobs j WHERE j.state_key=$1 AND (j.status IN ('queued','running','unknown') OR
        (j.created_at>now()-interval '7 days' AND j.id IN (SELECT DISTINCT ON(unit_id) id FROM artwork_jobs WHERE state_key=$1 ORDER BY unit_id,created_at DESC)))
      ORDER BY j.created_at DESC`, [productionStateKey()]),
    catalogDatabase().query("SELECT 1 FROM artwork_workers WHERE state_key=$1 AND heartbeat_at>now()-interval '35 seconds' LIMIT 1", [productionStateKey()]),
  ]);
  return { enabled: true, workerOnline: !!workers.rowCount, jobs: jobs.rows.map(row => ({ id: row.id, unitId: row.unit_id, status: row.status,
    message: row.message, error: row.error, candidate: row.candidate, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), steps: row.steps })) };
}
export async function claimArtworkJob(owner: string): Promise<ArtworkJob | null> {
  return catalogTransaction(async client => {
    const found = (await client.query(`SELECT * FROM artwork_jobs WHERE state_key=$1 AND (status='queued' OR (status='running' AND lease_until<now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [productionStateKey()])).rows[0];
    if (!found) return null;
    // A paid generation whose response was lost cannot be submitted a second time.
    const unknown = await client.query("SELECT 1 FROM artwork_job_steps WHERE job_id=$1 AND stage='generation' AND status IN ('running','unknown')", [found.id]);
    if (unknown.rowCount) {
      await client.query("UPDATE artwork_jobs SET status='unknown',message='生图返回结果不确定，请核对原任务，避免重复扣费',error='后台中断前的生图尚无已保存回执',owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [found.id]);
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
      if (job.status !== 'failed') throw new Error('仅处理失败的任务可从已保存步骤继续；内容不合格需要先修改要求');
      const unknown = await client.query("SELECT 1 FROM artwork_job_steps WHERE job_id=$1 AND status IN ('unknown','running') AND stage='generation'", [id]);
      if (unknown.rowCount) throw new Error('生图结果不确定，不能自动再次提交');
      await client.query("UPDATE artwork_jobs SET status='queued',message='已排队，从未完成步骤继续',error=NULL,updated_at=now() WHERE id=$1", [id]);
    }
    return job as ArtworkJob;
  });
}
