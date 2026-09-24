import { catalogDatabase } from './catalog-database';
import { catalogStorageConfig } from './catalog-files';
import { productionFileUrl } from '@/lib/production-file-url';

export async function claimProductionUpload(sha256: string, owner: string, tenantId: string) {
  if (!/^[0-9a-f]{64}$/u.test(sha256) || !/^[a-zA-Z0-9-]{16,64}$/u.test(owner)) throw new Error('上传指纹或操作 ID 无效');
  const storage = catalogStorageConfig();
  // Only a file this tenant already references may be claimed by hash. Matching on the hash
  // alone would turn this endpoint into an oracle: knowing a digest would hand out a URL for
  // bytes the caller never uploaded.
  const known = await catalogDatabase().query(
    `SELECT f.id FROM files f JOIN tenant_file_refs r ON r.file_id=f.id AND r.tenant_id=$4
      WHERE f.backend=$1 AND f.bucket=$2 AND f.sha256=$3 AND f.status='ready' AND f.gc_state='active'`,
    [storage.backend, storage.bucket, sha256, tenantId]);
  if (known.rowCount) return { status: 'ready' as const, url: productionFileUrl(known.rows[0].id) };
  const key = `upload:${storage.backend}:${storage.bucket}:${sha256}`;
  const claim = await catalogDatabase().query(`INSERT INTO production_operations(operation_key,owner,lease_until) VALUES($1,$2,now()+interval '5 minutes')
    ON CONFLICT(operation_key) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until,updated_at=now()
    WHERE production_operations.owner=EXCLUDED.owner OR production_operations.lease_until<now() RETURNING owner`, [key, owner]);
  return { status: claim.rowCount ? 'upload' as const : 'pending' as const };
}
