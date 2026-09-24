import { CatalogHttpError } from './catalog-auth';
import { catalogDatabase } from './catalog-database';

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }> };

/**
 * A file is readable when the tenant holds a reference to it — never because the caller knows
 * its id or its content hash. Objects stay de-duplicated by hash across tenants, so identity
 * alone proves nothing about who may read the bytes.
 */
export async function assertFileAccess(fileId: string, tenantId: string) {
  if (!/^[0-9a-f-]{36}$/u.test(fileId)) throw new CatalogHttpError(400, '文件地址无效');
  const found = await catalogDatabase().query(
    'SELECT 1 FROM tenant_file_refs WHERE file_id=$1 AND tenant_id=$2 LIMIT 1', [fileId, tenantId]);
  // Deliberately 404, not 403: a distinct "forbidden" would confirm the file exists.
  if (!found.rowCount) throw new CatalogHttpError(404, '文件不存在');
}

export const canAccessFile = async (fileId: string, tenantId: string) =>
  assertFileAccess(fileId, tenantId).then(() => true, () => false);

/** Record that a tenant may read a file. Safe to call repeatedly. */
export async function registerFileRef(
  fileId: string, tenantId: string, purpose: string, displayName = '', client?: Client,
) {
  const run = client ?? catalogDatabase();
  await run.query(
    'INSERT INTO tenant_file_refs(tenant_id,file_id,purpose,display_name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [tenantId, fileId, purpose, displayName]);
}
