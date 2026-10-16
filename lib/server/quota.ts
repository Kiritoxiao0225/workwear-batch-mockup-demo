import { CatalogHttpError } from './catalog-auth';
import { catalogDatabase } from './catalog-database';

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }> };

export type QuotaRequest = { id: string; tenantId: string; bytes?: number; styles?: number; ttlSeconds?: number };

const DEFAULT_TTL_SECONDS = 30 * 60;

/**
 * A look before bytes go to object storage. The transaction that records the file still makes the
 * binding check; this stops an account already at its quota from pushing objects that are then
 * refused and left behind, since nothing deletes them. A picture the tenant already holds costs no
 * space and passes.
 */
export async function assertStorageRoom(tenantId: string, bytes: number, sha256: string, db: Client = catalogDatabase()) {
  const { rows: [row] } = await db.query(`SELECT
      EXISTS(SELECT 1 FROM files f JOIN tenant_file_refs r ON r.file_id=f.id WHERE r.tenant_id=$1 AND f.sha256=$3 AND f.status='ready') AS held,
      EXISTS(SELECT 1 FROM tenant_usage u JOIN tenants t ON t.id=u.tenant_id
              WHERE u.tenant_id=$1 AND u.bytes_used+u.bytes_reserved+$2<=t.storage_quota_bytes) AS room`, [tenantId, bytes, sha256]);
  if (!row?.held && !row?.room) throw new CatalogHttpError(413, '存储空间不足');
}

/**
 * Reserve capacity before writing anything.
 *
 * Counting rows and then writing cannot hold a limit: two concurrent uploads both read the
 * old count and both pass. The reservation is a single conditional UPDATE instead, and the
 * record makes repeated confirmation, repeated release and crash leftovers resolvable.
 *
 * Runs inside the caller's transaction so a later failure rolls the reservation back too.
 */
export async function reserveQuota(client: Client, request: QuotaRequest) {
  const bytes = Math.max(0, Math.trunc(request.bytes ?? 0));
  const styles = Math.max(0, Math.trunc(request.styles ?? 0));
  if (!bytes && !styles) return;

  await client.query(
    `INSERT INTO quota_reservations(id,tenant_id,bytes,styles,expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
    [request.id, request.tenantId, bytes, styles, String(request.ttlSeconds ?? DEFAULT_TTL_SECONDS)]);

  const held = await client.query(
    `UPDATE tenant_usage u
        SET bytes_reserved = u.bytes_reserved + $2,
            style_reserved = u.style_reserved + $3
       FROM tenants t
      WHERE u.tenant_id = $1 AND t.id = u.tenant_id
        AND u.bytes_used + u.bytes_reserved + $2 <= t.storage_quota_bytes
        AND u.style_count + u.style_reserved + $3 <= t.style_quota
      RETURNING u.tenant_id`,
    [request.tenantId, bytes, styles]);

  if (!held.rowCount) {
    const limits = await client.query(
      `SELECT t.style_quota, t.storage_quota_bytes, u.style_count, u.style_reserved, u.bytes_used, u.bytes_reserved
         FROM tenants t JOIN tenant_usage u ON u.tenant_id = t.id WHERE t.id = $1`, [request.tenantId]);
    if (!limits.rowCount) throw new CatalogHttpError(403, '账号缺少用量记录，请联系管理员');
    const row = limits.rows[0] as Record<string, string | number>;
    const overStyles = Number(row.style_count) + Number(row.style_reserved) + styles > Number(row.style_quota);
    throw new CatalogHttpError(413, overStyles
      ? `款式数量已达上限（${row.style_quota} 款），请先删除不用的款式或升级套餐`
      : `存储空间不足（上限 ${(Number(row.storage_quota_bytes) / 1024 ** 3).toFixed(2)} GiB），请先清理或升级套餐`);
  }
}

/**
 * Turn a reservation into actual usage. `actual` may be smaller than the reservation — a
 * de-duplicated upload adds no new bytes — and the remainder is released.
 * Idempotent: a second call reports what already happened instead of moving numbers twice.
 */
export async function settleQuota(id: string, tenantId: string, actual: { bytes?: number; styles?: number }) {
  const resolved = await catalogDatabase().query(
    `UPDATE quota_reservations SET state='committed', resolved_at=now()
      WHERE id=$1 AND tenant_id=$2 AND state='reserved'
      RETURNING bytes, styles`, [id, tenantId]);
  if (!resolved.rowCount) return alreadyResolved(id, tenantId);

  const reserved = resolved.rows[0] as { bytes: string; styles: number };
  const usedBytes = Math.min(Math.max(0, Math.trunc(actual.bytes ?? 0)), Number(reserved.bytes));
  const usedStyles = Math.min(Math.max(0, Math.trunc(actual.styles ?? 0)), Number(reserved.styles));
  await catalogDatabase().query(
    `UPDATE tenant_usage
        SET bytes_reserved = bytes_reserved - $2, bytes_used = bytes_used + $3,
            style_reserved = style_reserved - $4, style_count = style_count + $5
      WHERE tenant_id = $1`,
    [tenantId, Number(reserved.bytes), usedBytes, Number(reserved.styles), usedStyles]);
  return { state: 'committed' as const };
}

/** Give the capacity back without counting any of it as used. */
export async function releaseQuota(id: string, tenantId: string) {
  const resolved = await catalogDatabase().query(
    `UPDATE quota_reservations SET state='released', resolved_at=now()
      WHERE id=$1 AND tenant_id=$2 AND state='reserved'
      RETURNING bytes, styles`, [id, tenantId]);
  if (!resolved.rowCount) return alreadyResolved(id, tenantId);
  const reserved = resolved.rows[0] as { bytes: string; styles: number };
  await catalogDatabase().query(
    `UPDATE tenant_usage SET bytes_reserved = bytes_reserved - $2, style_reserved = style_reserved - $3
      WHERE tenant_id = $1`, [tenantId, Number(reserved.bytes), Number(reserved.styles)]);
  return { state: 'released' as const };
}

/** Zero rows can mean four different things; say which rather than reporting success. */
async function alreadyResolved(id: string, tenantId: string) {
  const found = await catalogDatabase().query('SELECT tenant_id, state FROM quota_reservations WHERE id=$1', [id]);
  if (!found.rowCount) throw new CatalogHttpError(404, `配额预约不存在：${id}`);
  const row = found.rows[0] as { tenant_id: string; state: 'reserved' | 'committed' | 'released' };
  if (row.tenant_id !== tenantId) throw new CatalogHttpError(403, '配额预约不属于当前账号');
  return { state: row.state };
}

/**
 * An expiry means the upload never finished, so the held capacity goes back.
 * Without this, a crashed request would hold capacity forever.
 */
export async function sweepExpiredReservations(limit = 200) {
  const expired = await catalogDatabase().query(
    `UPDATE quota_reservations SET state='released', resolved_at=now()
      WHERE id IN (SELECT id FROM quota_reservations WHERE state='reserved' AND expires_at < now() ORDER BY expires_at LIMIT $1)
      RETURNING tenant_id, bytes, styles`, [limit]);
  for (const row of expired.rows as { tenant_id: string; bytes: string; styles: number }[]) {
    await catalogDatabase().query(
      `UPDATE tenant_usage SET bytes_reserved = bytes_reserved - $2, style_reserved = style_reserved - $3
        WHERE tenant_id = $1`, [row.tenant_id, Number(row.bytes), Number(row.styles)]);
  }
  return expired.rowCount ?? 0;
}

export async function tenantUsage(tenantId: string) {
  const found = await catalogDatabase().query(
    `SELECT u.style_count, u.style_reserved, u.bytes_used, u.bytes_reserved, t.style_quota, t.storage_quota_bytes
       FROM tenant_usage u JOIN tenants t ON t.id = u.tenant_id WHERE u.tenant_id = $1`, [tenantId]);
  if (!found.rowCount) throw new CatalogHttpError(404, '账号缺少用量记录');
  const row = found.rows[0] as Record<string, string | number>;
  return {
    styleCount: Number(row.style_count), styleQuota: Number(row.style_quota),
    bytesUsed: Number(row.bytes_used), storageQuotaBytes: Number(row.storage_quota_bytes),
    bytesReserved: Number(row.bytes_reserved), styleReserved: Number(row.style_reserved),
  };
}
