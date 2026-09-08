import { mkdir, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { productionStateKey, usesProductionCloud } from './production-storage';
import { catalogDatabase } from './catalog-database';

export type StoredCutout = ArtworkCutoutResult & { requestId: string; updatedAt: string; phase: 'ready' | 'submitting' | 'submitted' | 'finished'; providerResultUrl?: string; submissionNotStarted?: boolean; };
const root = () => process.env.ARTWORK_CUTOUT_CACHE_DIR || path.join(process.cwd(), 'data', 'artwork-cutouts');
function filename(key: string) { if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('抠图任务标识无效'); return path.join(root(), `${key}.json`); }
export async function assertCutoutStoreReady() {
  if (!usesProductionCloud()) return;
  try {
    await catalogDatabase().query('SELECT job_key FROM artwork_cutout_jobs LIMIT 0');
    const permission = await catalogDatabase().query("SELECT has_table_privilege(current_user, 'garment_catalog.artwork_cutout_jobs', 'INSERT') AND has_table_privilege(current_user, 'garment_catalog.artwork_cutout_jobs', 'UPDATE') AS writable");
    if (!permission.rows[0]?.writable) throw new Error('Cutout job storage is read-only');
  }
  catch { throw new Error('抠图服务尚未启用：请由数据库管理员执行 007_artwork_cutout_jobs.sql，并授予运行账号读写权限。本次尚未开始付费处理。'); }
}
export async function readCutoutJob(key: string): Promise<StoredCutout | null> {
  const file = filename(key);
  if (usesProductionCloud()) return (await catalogDatabase().query('SELECT job_json FROM artwork_cutout_jobs WHERE state_key=$1 AND job_key=$2', [productionStateKey(), key])).rows[0]?.job_json ?? null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function claimCutoutJob(job: StoredCutout) {
  const key = job.receipt.jobKey, file = filename(key);
  if (usesProductionCloud()) return (await catalogDatabase().query('INSERT INTO artwork_cutout_jobs(state_key,job_key,job_json) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [productionStateKey(), key, job])).rowCount === 1;
  await mkdir(root(), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  try { await link(temp, file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  finally { await unlink(temp); }
}
export async function saveCutoutJob(job: StoredCutout) {
  job.updatedAt = new Date().toISOString();
  const key = job.receipt.jobKey, file = filename(key);
  if (usesProductionCloud()) { await catalogDatabase().query('UPDATE artwork_cutout_jobs SET job_json=$3::jsonb,updated_at=now() WHERE state_key=$1 AND job_key=$2', [productionStateKey(), key, job]); return; }
  const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(job), { mode: 0o600 }); await rename(temp, file);
}
