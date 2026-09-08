import { catalogDatabase } from './catalog-database';
import { catalogStorageConfig } from './catalog-files';
import { productionFileUrl } from '@/lib/production-file-url';

export async function claimProductionUpload(sha256: string, owner: string) {
  if (!/^[0-9a-f]{64}$/u.test(sha256) || !/^[a-zA-Z0-9-]{16,64}$/u.test(owner)) throw new Error('上传指纹或操作 ID 无效');
  const storage = catalogStorageConfig();
  const known = await catalogDatabase().query("SELECT id FROM files WHERE backend=$1 AND bucket=$2 AND sha256=$3 AND status='ready' AND gc_state='active'", [storage.backend, storage.bucket, sha256]);
  if (known.rowCount) return { status: 'ready' as const, url: productionFileUrl(known.rows[0].id) };
  const key = `upload:${storage.backend}:${storage.bucket}:${sha256}`;
  const claim = await catalogDatabase().query(`INSERT INTO production_operations(operation_key,owner,lease_until) VALUES($1,$2,now()+interval '5 minutes')
    ON CONFLICT(operation_key) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until,updated_at=now()
    WHERE production_operations.owner=EXCLUDED.owner OR production_operations.lease_until<now() RETURNING owner`, [key, owner]);
  return { status: claim.rowCount ? 'upload' as const : 'pending' as const };
}
