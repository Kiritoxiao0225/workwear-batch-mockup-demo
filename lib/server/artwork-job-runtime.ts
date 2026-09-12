import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ARTWORK_STAGE_LABELS, type ArtworkStage } from '@/lib/artwork-jobs';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { readProductionFile, saveProductionFile, persistProductionReferences } from './production-storage';
import { assertArtworkJobOwner, retainJobFiles, type ArtworkJob } from './artwork-job-store';
import type { InspectionRetryNotice } from './artwork-inspection-retry';

const context = new AsyncLocalStorage<{ job: ArtworkJob; pending: Map<string, Promise<unknown>>; held?: ArtworkStage }>();
export const hasArtworkJobContext = () => !!context.getStore();
/** Explicit, consented retry applies only to the failed source, without altering generation input. */
export const currentCutoutRecovery = () => context.getStore()?.job.input.cutoutRecovery;
export function inArtworkJob<T>(job: ArtworkJob, task: () => Promise<T>) { return context.run({ job, pending: new Map() }, task); }
export const artworkStepHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? 'null').digest('hex');
export class ArtworkGenerationUnknownError extends Error {}

export async function reportArtworkInspectionRetry(notice: InspectionRetryNotice) {
  const current = context.getStore();
  if (!current) return;
  await catalogTransaction(async client => {
    await assertArtworkJobOwner(client, current.job);
    await client.query("UPDATE artwork_jobs SET message=$3,updated_at=now() WHERE id=$1 AND owner=$2", [current.job.id, current.job.owner,
      `核对服务暂时未响应，正在自动恢复（第 ${notice.attempt}/${notice.maxAttempts} 次），无需重复制作`]);
  });
}

/** A resumed full-image job keeps its paid prompt even after a code/template upgrade. */
export async function resumeArtworkGenerationPrompt(prompt: string, images: string[], settings: { background?: 'auto' | 'transparent' }) {
  const current = context.getStore();
  if (!current) return prompt;
  const db = catalogDatabase();
  const steps = (await db.query("SELECT step_key,status FROM artwork_job_steps WHERE job_id=$1 AND stage='generation'", [current.job.id])).rows;
  const key = (text: string) => `generate:${artworkStepHash([text, images, settings])}`;
  if (steps.some(step => step.step_key === key(prompt) && step.status !== 'failed') || !steps.some(step => step.status !== 'failed')) return prompt;
  const receipt = (await db.query(`SELECT r.record_json FROM artwork_run_records r JOIN artwork_jobs j
    ON r.state_key=j.state_key AND r.run_id::text=j.candidate->>'runId'
    WHERE j.id=$1 AND r.kind='generation'`, [current.job.id])).rows[0]?.record_json;
  if (!receipt?.component && typeof receipt?.prompt === 'string'
    && steps.some(step => step.step_key === key(receipt.prompt) && step.status === 'completed')) return receipt.prompt as string;
  throw new Error('已保留原生图步骤，但无法匹配原提示词与素材；已停止重复生图，请查看或下载原任务图片');
}

export async function saveArtworkJobFile(bytes: Buffer, name: string) {
  const current = context.getStore();
  return saveProductionFile(bytes, name, current ? async (client, id) => {
    // Retain while the file lock is still held: a reused former artwork cannot be
    // collected between upload completion and the checkpoint transaction.
    await retainJobFiles(client, current.job.id, `/api/production-files/${id}`);
  } : undefined);
}

// Binary results live in immutable object storage, not multi-megabyte JSON rows.
async function pack(value: unknown): Promise<unknown> {
  if (Buffer.isBuffer(value)) return { $artworkBuffer: (await saveArtworkJobFile(value, 'job-step.png')).url };
  if (typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,/u.test(value)) {
    const mimeType = value.slice(5, value.indexOf(';'));
    const file = await saveArtworkJobFile(Buffer.from(value.slice(value.indexOf(',') + 1), 'base64'), 'job-image.png');
    return { $artworkDataUrl: file.url, mimeType };
  }
  if (Array.isArray(value)) return Promise.all(value.map(pack));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).filter(([, entry]) => entry !== undefined).map(async ([key, entry]) => [key, await pack(entry)])));
  return value ?? null;
}
async function unpack(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(unpack));
  if (value && typeof value === 'object') {
    if ('$artworkDataUrl' in value && typeof value.$artworkDataUrl === 'string' && 'mimeType' in value) return `data:${value.mimeType};base64,${(await readProductionFile(value.$artworkDataUrl)).toString('base64')}`;
    if ('$artworkBuffer' in value && typeof value.$artworkBuffer === 'string') return readProductionFile(value.$artworkBuffer);
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await unpack(entry)])));
  }
  return value;
}

/** DB slots are shared across all worker processes, independent for each provider stage. */
export async function withArtworkStage<T>(stage: ArtworkStage, task: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current || current.held === stage) return task();
  const { job } = current;
  await catalogDatabase().query("UPDATE artwork_jobs SET message=$3,updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'", [job.id, job.owner, `等待${ARTWORK_STAGE_LABELS[stage]}空位`]);
  let slot: number | undefined;
  while (slot === undefined) {
    slot = await catalogTransaction(async client => {
      await assertArtworkJobOwner(client, job);
      const row = (await client.query(`SELECT slot FROM artwork_stage_slots WHERE stage=$1 AND (owner IS NULL OR lease_until<now())
        AND available_at<=now() ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1`, [stage])).rows[0];
      if (!row) return undefined;
      await client.query("UPDATE artwork_stage_slots SET owner=$3,job_id=$4,lease_until=now()+interval '5 minutes' WHERE stage=$1 AND slot=$2", [stage, row.slot, job.owner, job.id]);
      return Number(row.slot);
    });
    if (slot === undefined) await delay(300);
  }
  try {
    await catalogDatabase().query("UPDATE artwork_jobs SET message=$3,updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'", [job.id, job.owner, `正在${ARTWORK_STAGE_LABELS[stage]}`]);
    return await context.run({ ...current, held: stage }, task);
  } finally {
    // Token and job fence an old worker from releasing a newer worker's slot.
    await catalogDatabase().query(`UPDATE artwork_stage_slots SET owner=NULL,job_id=NULL,lease_until=NULL,
      available_at=now()+CASE WHEN stage='quality' THEN interval '1 second' ELSE interval '0 seconds' END
      WHERE stage=$1 AND slot=$2 AND owner=$3 AND job_id=$4`, [stage, slot, job.owner, job.id]);
  }
}

/** Successful steps replay their stored result. Only the failed step is called again. */
export async function artworkJobStep<T>(name: string, stage: ArtworkStage, args: unknown, task: () => Promise<T>, acquireSlot = true, paid = false): Promise<T> {
  const current = context.getStore();
  if (!current) return task();
  const key = `${name}:${artworkStepHash(args)}`;
  const previous = current.pending.get(key);
  if (previous) return previous as Promise<T>;
  const run = (async () => {
    const row = (await catalogDatabase().query('SELECT * FROM artwork_job_steps WHERE job_id=$1 AND step_key=$2', [current.job.id, key])).rows[0];
    if (row?.status === 'completed') return await unpack(row.result) as T;
    if ((stage === 'generation' || paid) && ['running', 'unknown'].includes(row?.status)) throw new ArtworkGenerationUnknownError('已有生图提交尚无确定回执，已停止重复提交');
    const execute = async () => {
      await catalogTransaction(async client => {
        await assertArtworkJobOwner(client, current.job);
        await client.query(`INSERT INTO artwork_job_steps(job_id,step_key,stage,status) VALUES($1,$2,$3,'running')
          ON CONFLICT(job_id,step_key) DO UPDATE SET status='running',error=NULL,started_at=now(),finished_at=NULL`, [current.job.id, key, stage]);
      });
      let returned = false;
      try {
        const value = await task();
        returned = true;
        const packed = await persistProductionReferences(await pack(value));
        await catalogTransaction(async client => {
          await assertArtworkJobOwner(client, current.job);
          await retainJobFiles(client, current.job.id, packed);
          await client.query("UPDATE artwork_job_steps SET status='completed',result=$3,error=NULL,finished_at=now() WHERE job_id=$1 AND step_key=$2", [current.job.id, key, packed]);
        });
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Explicit rate rejection is safe to retry; timeouts/disconnects are not.
        const unknown = (stage === 'generation' || paid) && (returned || !/(?:HTTP\s*(?:400|401|403|404|413|422|429)|RequestLimitExceeded|未发起生图请求|CLIPROXY_API_BASE_URL 必须|尚未配置|not configured)/iu.test(message));
        await catalogTransaction(async client => {
          await assertArtworkJobOwner(client, current.job);
          await client.query('UPDATE artwork_job_steps SET status=$3,error=$4,finished_at=now() WHERE job_id=$1 AND step_key=$2', [current.job.id, key, unknown ? 'unknown' : 'failed', message.slice(0, 2000)]);
        });
        if (unknown) throw new ArtworkGenerationUnknownError(`生图结果尚不确定，已停止重复提交：${message}`);
        throw error;
      }
    };
    return acquireSlot ? withArtworkStage(stage, execute) : execute();
  })();
  current.pending.set(key, run);
  try { return await run; } catch (error) { current.pending.delete(key); throw error; }
}

/** A crop/recognition upgrade must not repurchase a full image already generated
 * from these exact original inputs. Both alternatives still match saved step keys. */
export async function resumeArtworkGenerationInput(prompt: string, images: string[], settings: { background?: 'auto' | 'transparent' }, originalImages: string[]) {
  try { return { prompt: await resumeArtworkGenerationPrompt(prompt, images, settings), images, reusedOriginalInput: false }; }
  catch (error) {
    if (JSON.stringify(images) === JSON.stringify(originalImages)) throw error;
    return { prompt: await resumeArtworkGenerationPrompt(prompt, originalImages, settings), images: originalImages, reusedOriginalInput: true };
  }
}
