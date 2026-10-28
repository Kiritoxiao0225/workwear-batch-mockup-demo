import { catalogDatabase } from './catalog-database';
import { tenantUsage } from './quota';
import { assetUrl } from './listing-store';

/** What a tenant's files are for, as the 存储空间 page groups them. */
export type StoragePart = 'listing' | 'artwork' | 'layouts' | 'other';
const PART_OF: Record<string, StoragePart> = { 'listing-images': 'listing', batch: 'artwork', 'listing-layouts': 'layouts' };

export type StorageProduct = {
  id: string; name: string; kind: 'product' | 'shop'; status: string;
  updatedAt: string; sourcesCleared: boolean; cover: string | null;
  files: number; bytes: number; freeableBytes: number;
};

/**
 * Where a tenant's space goes (存储空间 page, 10-28).
 *
 * A file is stored once however many products show it, so a product's `bytes` and what deleting
 * it gives back differ: `freeableBytes` counts only the files no other live product and no other
 * feature of this tenant still uses — the same rule deleteProject's releaseFiles applies.
 */
export async function storageUsage(tenantId: string) {
  const db = catalogDatabase();
  const [usage, parts, products] = await Promise.all([
    tenantUsage(tenantId),
    // A file held for two purposes is counted once, under the first.
    db.query(`SELECT purpose, sum(byte_length)::bigint AS bytes, count(*)::int AS files FROM (
        SELECT DISTINCT ON (r.file_id) r.purpose, f.byte_length FROM tenant_file_refs r JOIN files f ON f.id=r.file_id
         WHERE r.tenant_id=$1 ORDER BY r.file_id, r.purpose) x GROUP BY purpose`, [tenantId]),
    db.query(`WITH live AS (SELECT id FROM listing_projects WHERE tenant_id=$1 AND deleted_at IS NULL),
        pf AS (SELECT DISTINCT a.project_id, a.file_id FROM listing_assets a JOIN live ON live.id=a.project_id),
        uses AS (SELECT file_id, count(*) AS n FROM pf GROUP BY file_id),
        other AS (SELECT DISTINCT file_id FROM tenant_file_refs WHERE tenant_id=$1 AND purpose<>'listing-images'),
        sized AS (SELECT pf.project_id, count(*)::int AS files, sum(f.byte_length)::bigint AS bytes,
                         COALESCE(sum(f.byte_length) FILTER (WHERE u.n=1 AND o.file_id IS NULL), 0)::bigint AS freeable
                    FROM pf JOIN files f ON f.id=pf.file_id JOIN uses u ON u.file_id=pf.file_id LEFT JOIN other o ON o.file_id=pf.file_id
                   GROUP BY pf.project_id)
      SELECT p.id, p.name, p.kind, p.status, p.updated_at, p.sources_cleared_at, s.files, s.bytes, s.freeable,
             COALESCE((SELECT a.id FROM listing_assets a WHERE a.project_id=p.id AND a.slot='square:1' AND (NOT a.candidate OR a.chosen_at IS NOT NULL) ORDER BY GREATEST(a.created_at, COALESCE(a.chosen_at, a.created_at)) DESC LIMIT 1),
                      (SELECT a.id FROM listing_assets a WHERE a.project_id=p.id AND a.kind='source' ORDER BY a.rel_path LIMIT 1)) AS cover
        FROM sized s JOIN listing_projects p ON p.id=s.project_id
       ORDER BY s.bytes DESC, p.updated_at DESC`, [tenantId]),
  ]);
  const byPart: Record<StoragePart, { bytes: number; files: number }> = {
    listing: { bytes: 0, files: 0 }, artwork: { bytes: 0, files: 0 }, layouts: { bytes: 0, files: 0 }, other: { bytes: 0, files: 0 },
  };
  for (const row of parts.rows) {
    const part = byPart[PART_OF[row.purpose as string] ?? 'other'];
    part.bytes += Number(row.bytes); part.files += Number(row.files);
  }
  return {
    usage: { bytesUsed: usage.bytesUsed, storageQuotaBytes: usage.storageQuotaBytes },
    parts: byPart,
    products: products.rows.map((row): StorageProduct => ({
      id: row.id as string, name: row.name as string, kind: row.kind as 'product' | 'shop', status: row.status as string,
      updatedAt: (row.updated_at as Date).toISOString(), sourcesCleared: Boolean(row.sources_cleared_at),
      cover: row.cover ? assetUrl(row.cover as string) : null,
      files: Number(row.files), bytes: Number(row.bytes), freeableBytes: Number(row.freeable),
    })),
  };
}
