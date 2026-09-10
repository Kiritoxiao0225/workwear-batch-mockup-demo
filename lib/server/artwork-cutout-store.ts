import { mkdir, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { productionStateKey, usesProductionCloud } from './production-storage';
import { catalogDatabase } from './catalog-database';
import { saveProductionFile, readProductionFile } from './production-storage';

export type StoredCutout = ArtworkCutoutResult & { requestId: string; updatedAt: string; phase: 'ready' | 'submitting' | 'submitted' | 'finished'; providerResultUrl?: string; submissionNotStarted?: boolean; };
const cutoutFileReferencesEnabled = () => process.env.ARTWORK_CUTOUT_FILE_STORAGE === 'oss';
const root = () => process.env.ARTWORK_CUTOUT_CACHE_DIR || path.join(process.cwd(), 'data', 'artwork-cutouts');
function filename(key: string) { if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('抠图任务标识无效'); return path.join(root(), `${key}.json`); }
export async function assertCutoutStoreReady() {
  if (!usesProductionCloud()) return;
  try {
    await catalogDatabase().query('SELECT job_key FROM artwork_cutout_jobs LIMIT 0');
    if (cutoutFileReferencesEnabled()) await catalogDatabase().query('SELECT file_id FROM artwork_cutout_files LIMIT 0');
    const permission = await catalogDatabase().query("SELECT has_table_privilege(current_user, 'garment_catalog.artwork_cutout_jobs', 'INSERT') AND has_table_privilege(current_user, 'garment_catalog.artwork_cutout_jobs', 'UPDATE') AS writable");
    if (!permission.rows[0]?.writable) throw new Error('Cutout job storage is read-only');
  }
  catch { throw new Error('抠图服务尚未启用：请由数据库管理员执行 007_artwork_cutout_jobs.sql 和 012_production_reliability.sql，并授予运行账号读写权限。本次尚未开始付费处理。'); }
}
export async function readCutoutJob(key: string): Promise<StoredCutout | null> {
  const file = filename(key);
  if (usesProductionCloud()) {
    const stored = (await catalogDatabase().query('SELECT job_json FROM artwork_cutout_jobs WHERE state_key=$1 AND job_key=$2', [productionStateKey(), key])).rows[0]?.job_json;
    return stored ? await unpackCutoutImages(stored) as StoredCutout : null;
  }
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function claimCutoutJob(job: StoredCutout) {
  const key = job.receipt.jobKey, file = filename(key);
  if (usesProductionCloud()) return (await catalogDatabase().query('INSERT INTO artwork_cutout_jobs(state_key,job_key,job_json) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [productionStateKey(), key, (cutoutFileReferencesEnabled() ? await packCutoutImages(job, key) : job)])).rowCount === 1;
  await mkdir(root(), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  try { await link(temp, file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  finally { await unlink(temp); }
}
export async function saveCutoutJob(job: StoredCutout) {
  job.updatedAt = new Date().toISOString();
  const key = job.receipt.jobKey, file = filename(key);
  if (usesProductionCloud()) { await catalogDatabase().query('UPDATE artwork_cutout_jobs SET job_json=$3::jsonb,updated_at=now() WHERE state_key=$1 AND job_key=$2', [productionStateKey(), key, (cutoutFileReferencesEnabled() ? await packCutoutImages(job, key) : job)]); return; }
  const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(job), { mode: 0o600 }); await rename(temp, file);
}

/** Lossless storage envelope. Hydration keeps existing API/PNG consumers compatible. */
export async function packCutoutImages(value: unknown, key: string): Promise<unknown> {
  if (typeof value === 'string') {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(value);
    if (!match) return value;
    const saved = await saveProductionFile(Buffer.from(match[2], 'base64'), `cutout-${key}.${match[1].split('/')[1]}`, async (client, id) => {
      await client.query('INSERT INTO artwork_cutout_files(state_key,job_key,file_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [productionStateKey(), key, id]);
    });
    return { $cutoutImage: { url: saved.url, mimeType: match[1] } };
  }
  if (Array.isArray(value)) { const result = []; for (const item of value) result.push(await packCutoutImages(item, key)); return result; }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) result[name] = await packCutoutImages(item, key);
    return result;
  }
  return value;
}
export async function unpackCutoutImages(value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object') return value;
  if ('$cutoutImage' in value) {
    const image = value.$cutoutImage as { url: string; mimeType: string };
    if (!/^image\/(png|jpeg|webp)$/u.test(image.mimeType)) throw new Error('抠图存档图片格式无效');
    return `data:${image.mimeType};base64,${(await readProductionFile(image.url)).toString('base64')}`;
  }
  if (Array.isArray(value)) return Promise.all(value.map(unpackCutoutImages));
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await unpackCutoutImages(item)])));
}
/** Bounded backfill; a simultaneous provider update always wins over migration. */
export async function migrateCutoutImages(limit = 10) {
  if (!usesProductionCloud()) throw new Error('抠图存档迁移需要云存储');
  const rows = (await catalogDatabase().query("SELECT job_key,job_json FROM artwork_cutout_jobs WHERE state_key=$1 AND job_json::text LIKE '%data:image/%' ORDER BY updated_at LIMIT $2", [productionStateKey(), limit])).rows;
  let migrated = 0;
  for (const row of rows) {
    const packed = await packCutoutImages(row.job_json, row.job_key);
    migrated += (await catalogDatabase().query('UPDATE artwork_cutout_jobs SET job_json=$3::jsonb WHERE state_key=$1 AND job_key=$2 AND job_json=$4::jsonb', [productionStateKey(), row.job_key, packed, row.job_json])).rowCount;
  }
  return { scanned: rows.length, migrated };
}
