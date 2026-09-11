import { randomUUID } from 'node:crypto';
import { unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { catalogObjectPrefix, catalogStorageConfig } from './catalog-files';
import { imageStoreRequest } from './catalog-image-store';
import { catalogOssBucketControl, catalogOssObjects } from './catalog-oss';

const unreferenced = `f.status='ready' AND NOT EXISTS(SELECT 1 FROM production_file_refs r WHERE r.file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM artwork_job_files j WHERE j.file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM artwork_cutout_files c WHERE c.file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM wps_analysis_files a WHERE a.file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM production_renders r WHERE r.file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM garment_asset_versions v WHERE v.file_id=f.id OR v.thumbnail_file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM asset_sources s WHERE s.file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM import_items i WHERE i.file_id=f.id)`;
const absent = (error: unknown) => error && typeof error === 'object' && 'code' in error && ['NoSuchKey', 'NoSuchVersion', 'ENOENT'].includes(String(error.code));

/** Called in the same transaction that replaces a reference. No timer or grace period. */
export async function queueReplacedFiles(client: CatalogQueryClient, ids: string[]) {
  if (!ids.length) return;
  await client.query(`INSERT INTO production_operations(operation_key,owner,lease_until)
    SELECT 'delete:'||id::text,'pending',now() FROM unnest($1::uuid[]) AS id
    ON CONFLICT(operation_key) DO NOTHING`, [[...new Set(ids)]]);
}

/** Runs after a response. Failures remain recorded for the next save/read to retry. */
export async function cleanupReplacedFiles(limit = 20, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs;
  const storage = catalogStorageConfig();
  const prefix = `${storage.backend !== 'local' ? `${catalogObjectPrefix()}/` : ''}production/objects/`;
  const candidates = (await catalogDatabase().query(`SELECT substring(operation_key FROM 8)::uuid AS id FROM production_operations
    WHERE operation_key LIKE 'delete:%' AND lease_until<=now() ORDER BY updated_at LIMIT $1`, [limit])).rows;
  const deleted: string[] = [], failures: { id: string; error: string }[] = [];
  if (!candidates.length) return { deleted, failures };
  if (storage.backend === 'oss' && (!process.env.PRODUCTION_DELETE_ACCESS_KEY_ID || !process.env.PRODUCTION_DELETE_ACCESS_KEY_SECRET)) throw new Error('替换后的旧图删除尚未配置 PRODUCTION_DELETE_ACCESS_KEY_ID / SECRET');
  const client = storage.backend === 'oss' ? catalogOssObjects(storage.bucket, 'cleanup') : null;
  const versioning = client ? await catalogOssBucketControl(storage.bucket).getBucketVersioning(storage.bucket) : null;
  for (const candidate of candidates) {
    if (Date.now() + 15_000 > deadline) break;
    const operationKey = `delete:${candidate.id}`;
    const owner = randomUUID();
    const file = await catalogTransaction(async transaction => {
      const row = (await transaction.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [candidate.id])).rows[0];
      const pending = await transaction.query('SELECT operation_key FROM production_operations WHERE operation_key=$1 AND lease_until<=now() FOR UPDATE', [operationKey]);
      if (!pending.rowCount) return null;
      const unused = row && (await transaction.query(`SELECT id FROM files f WHERE id=$1 AND ${unreferenced}`, [row.id])).rowCount;
      if (!row || row.gc_state === 'deleted' || row.backend !== storage.backend || row.bucket !== storage.bucket || !row.object_key.startsWith(prefix) || !unused) {
        await transaction.query('DELETE FROM production_operations WHERE operation_key=$1', [operationKey]);
        return null;
      }
      if (!/^[0-9a-f]{2}\/[0-9a-f]{64}$/u.test(row.object_key.slice(prefix.length))) throw new Error('旧图删除目录检查失败');
      await transaction.query('DELETE FROM production_render_cache WHERE file_id=$1', [row.id]);
      await transaction.query("UPDATE files SET gc_state='deleting' WHERE id=$1", [row.id]);
      await transaction.query("UPDATE production_operations SET owner=$2,lease_until=now()+interval '1 minute',updated_at=now() WHERE operation_key=$1", [operationKey, owner]);
      return row;
    });
    if (!file) continue;
    try {
      if (client) {
        const versionId = versioning?.versionStatus ? file.object_version_id ?? 'null' : undefined;
        const options = { timeout: 5000, ...(versionId ? { versionId } : {}) };
        try { await client.delete(file.object_key, options); } catch (error) { if (!absent(error)) throw error; }
        try { await client.head(file.object_key, options); throw new Error('旧图删除后仍可读取'); } catch (error) { if (!absent(error)) throw error; }
        try { await client.head(file.object_key); throw new Error('旧图仍存在历史对象'); } catch (error) { if (!absent(error)) throw error; }
      } else if (storage.backend === 'zeabur') {
        await imageStoreRequest(file.object_key, 'DELETE');
        try { await imageStoreRequest(file.object_key, 'HEAD'); throw new Error('旧图删除后仍可读取'); } catch (error) { if (!absent(error)) throw error; }
      } else {
        const target = path.join(storage.bucket, file.object_key);
        try { await unlink(target); } catch (error) { if (!absent(error)) throw error; }
        try { await access(target); throw new Error('旧图删除后仍存在'); } catch (error) { if (!absent(error)) throw error; }
      }
      await catalogTransaction(async transaction => {
        await transaction.query("UPDATE files SET gc_state='deleted',status='failed',error='replaced production image deleted' WHERE id=$1 AND gc_state='deleting'", [file.id]);
        await transaction.query('DELETE FROM production_operations WHERE operation_key=$1 AND owner=$2', [operationKey, owner]);
      });
      deleted.push(file.id);
    } catch (error) {
      failures.push({ id: file.id, error: error instanceof Error ? error.message : String(error) });
      await catalogDatabase().query("UPDATE production_operations SET lease_until=now()+interval '30 seconds',updated_at=now() WHERE operation_key=$1 AND owner=$2", [operationKey, owner]);
    }
  }
  return { deleted, failures };
}
