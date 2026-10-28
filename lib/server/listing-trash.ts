/**
 * 回收站 for 电商主图 (存储空间 stage 2, 10-28).
 *
 * A deletion gives the space back at once and keeps everything needed to undo it for TRASH_DAYS:
 * 「彻底删除」 hides the product (deleted_at), 「只删原图」/「只删图片」 move the picture rows into
 * listing_assets_trash. The files stay in object storage until the daily clean-up (stage 3) deletes
 * them after `purge_after`; 「立即彻底删除」 only brings that time forward.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile, saveCatalogFile } from './catalog-files';
import { registerFileRef } from './file-authorization';
import { releaseFiles } from './listing-store';

export const TRASH_DAYS = 7;
export const REMOVE_MODES = ['sources', 'images', 'all'] as const;
export type RemoveMode = (typeof REMOVE_MODES)[number];
const THUMB_EDGE = 400;

export type TrashItem = {
  id: string; feature: 'listing' | 'artwork'; targetId: string; mode: RemoveMode; name: string;
  bytes: number; files: number; createdAt: string; purgeAfter: string;
  /** False when a later deletion of the same record must be restored first. */
  restorable: boolean;
};

// listing_assets_trash is `LIKE listing_assets` plus trash_id; moving rows names the shared columns
// so a column added to listing_assets later only needs adding to the trash table too.
let columns: string | null = null;
async function assetColumns(c: CatalogQueryClient) {
  if (columns) return columns;
  const rows = (await c.query(`SELECT a.column_name FROM information_schema.columns a
      JOIN information_schema.columns t ON t.table_schema=a.table_schema AND t.table_name='listing_assets_trash' AND t.column_name=a.column_name
     WHERE a.table_schema=current_schema() AND a.table_name='listing_assets' ORDER BY a.ordinal_position`)).rows;
  if (!rows.length) throw new Error('listing_assets_trash 缺少列');
  return (columns = rows.map(r => `"${r.column_name as string}"`).join(','));
}

/**
 * The small cover 「只删图片」 leaves behind: the current first square image, or else the first upload.
 * Made before the deletion in its own transaction; a failure just means no cover.
 */
async function keepThumb(tenant: string, projectId: string) {
  const cover = (await catalogDatabase().query(
    `SELECT file_id FROM listing_assets WHERE project_id=$1 AND (slot='square:1' AND (NOT candidate OR chosen_at IS NOT NULL) OR kind='source')
      ORDER BY (slot='square:1') DESC NULLS LAST, GREATEST(created_at, COALESCE(chosen_at, created_at)) DESC, rel_path LIMIT 1`, [projectId])).rows[0];
  if (!cover) return null;
  try {
    const bytes = await sharp((await readCatalogFile(cover.file_id as string)).bytes, { failOn: 'none' })
      .rotate().resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer({ resolveWithObject: true });
    let asset = '';
    await saveCatalogFile(bytes.data, 'cover-thumb.webp', 'production', async (c, fileId) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
      const owned = await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [tenant, fileId]);
      // A few KB, counted but never refused: the deletion it belongs to frees far more.
      if (!owned.rowCount) await c.query('UPDATE tenant_usage SET bytes_used=bytes_used+$2 WHERE tenant_id=$1', [tenant, bytes.data.length]);
      asset = randomUUID();
      await c.query(`INSERT INTO listing_assets(id,tenant_id,project_id,file_id,kind,name,rel_path,width,height)
        VALUES($1,$2,$3,$4,'thumb','cover-thumb.webp',$5,$6,$7)`, [asset, tenant, projectId, fileId, `thumb#${asset}`, bytes.info.width, bytes.info.height]);
      await registerFileRef(fileId, tenant, 'listing-images', 'cover-thumb.webp', c);
    });
    return asset;
  } catch (error) {
    console.error('[listing-trash] cover thumb', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Delete one way or another; everything is restorable for TRASH_DAYS. */
export async function removeProject(tenant: string, user: string | null, id: string, mode: RemoveMode) {
  z.uuid().parse(id);
  z.enum(REMOVE_MODES).parse(mode);
  const project = (await catalogDatabase().query(`SELECT images_cleared_at, sources_cleared_at FROM listing_projects
    WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL AND kind='product'`, [id, tenant])).rows[0];
  if (!project) throw new CatalogHttpError(404, '商品不存在');
  if (mode === 'sources' && project.sources_cleared_at) throw new CatalogHttpError(409, '这款的原图已经清理过了');
  if (mode === 'images' && project.images_cleared_at) throw new CatalogHttpError(409, '这款的图片已经清理过了');
  const thumb = mode === 'images' ? await keepThumb(tenant, id) : null;
  try {
    return await removeIn(tenant, user, id, mode, thumb);
  } catch (error) {
    // Refused (still drawing, already cleared…): the cover made for it goes again.
    if (thumb) await catalogTransaction(async c => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
      await releaseFiles(c, tenant, (await c.query(`DELETE FROM listing_assets WHERE id=$1 AND kind='thumb' RETURNING file_id`, [thumb])).rows.map(r => r.file_id as string));
    }).catch(() => {});
    throw error;
  }
}

function removeIn(tenant: string, user: string | null, id: string, mode: RemoveMode, thumb: string | null) {
  return catalogTransaction(async c => {
    await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
    const p = (await c.query(`SELECT name, sources_cleared_at, images_cleared_at FROM listing_projects
      WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL AND kind='product' FOR UPDATE`, [id, tenant])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    const running = await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND tenant_id=$2 AND status IN ('queued','running') LIMIT 1`, [id, tenant]);
    if (running.rowCount) throw new CatalogHttpError(409, '正在分析或出图，等完成后再删除');
    const trash = randomUUID();
    let files: string[];
    if (mode === 'all') {
      await c.query('UPDATE listing_projects SET deleted_at=now() WHERE id=$1', [id]);
      files = (await c.query('SELECT file_id FROM listing_assets WHERE project_id=$1', [id])).rows.map(r => r.file_id as string);
    } else {
      // The trash row must exist before the pictures that point at it.
      await c.query(`INSERT INTO trash_items(id,tenant_id,created_by,feature,target_id,mode,name,purge_after)
        VALUES($1,$2,$3,'listing',$4,$5,$6,now() + make_interval(days => $7))`, [trash, tenant, user, id, mode, p.name, TRASH_DAYS]);
      const cols = await assetColumns(c);
      const kinds = mode === 'sources' ? ['source'] : ['source', 'product', 'output', 'ref'];
      const moved = await c.query(`WITH gone AS (DELETE FROM listing_assets WHERE project_id=$1 AND kind = ANY($2::text[]) RETURNING *)
        INSERT INTO listing_assets_trash(${cols},trash_id) SELECT ${cols},$3 FROM gone RETURNING file_id`, [id, kinds, trash]);
      files = moved.rows.map(r => r.file_id as string);
      if (!files.length && mode === 'sources') throw new CatalogHttpError(409, '这款没有可清理的原图');
      await c.query(`UPDATE listing_projects SET sources_cleared_at=COALESCE(sources_cleared_at, now()),
        images_cleared_at=CASE WHEN $2 THEN now() ELSE images_cleared_at END WHERE id=$1`, [id, mode === 'images']);
    }
    const freed = await releaseFiles(c, tenant, files);
    const state = { sourcesClearedAt: p.sources_cleared_at ?? null, imagesClearedAt: p.images_cleared_at ?? null, thumb };
    if (mode === 'all') {
      await c.query(`INSERT INTO trash_items(id,tenant_id,created_by,feature,target_id,mode,name,bytes,files,state,purge_after)
        VALUES($1,$2,$3,'listing',$4,'all',$5,$6,$7,$8,now() + make_interval(days => $9))`, [trash, tenant, user, id, p.name, freed, new Set(files).size, state, TRASH_DAYS]);
    } else {
      await c.query('UPDATE trash_items SET bytes=$2, files=$3, state=$4 WHERE id=$1', [trash, freed, new Set(files).size, state]);
    }
    return { ok: true, trashId: trash, freedBytes: freed };
  });
}

/**
 * Count the files back against the tenant: those it no longer holds cost their size again, and the
 * restore is refused, before anything moves, if they no longer fit.
 */
async function reclaimFiles(c: CatalogQueryClient, tenant: string, fileIds: string[]) {
  const ids = [...new Set(fileIds)];
  if (!ids.length) return;
  const need = Number((await c.query(`SELECT COALESCE(sum(f.byte_length),0)::bigint AS n FROM files f WHERE f.id = ANY($2::uuid[])
      AND NOT EXISTS (SELECT 1 FROM tenant_file_refs r WHERE r.tenant_id=$1 AND r.file_id=f.id)`, [tenant, ids])).rows[0].n);
  if (need) {
    const room = await c.query(`UPDATE tenant_usage u SET bytes_used=bytes_used+$2 FROM tenants t
      WHERE u.tenant_id=$1 AND t.id=u.tenant_id AND u.bytes_used+u.bytes_reserved+$2<=t.storage_quota_bytes RETURNING u.tenant_id`, [tenant, need]);
    if (!room.rowCount) throw new CatalogHttpError(413, `空间不够恢复：要占回 ${(need / 1024 ** 2).toFixed(0)} MB，先删掉别的再恢复`);
  }
  for (const id of ids) await registerFileRef(id, tenant, 'listing-images', '', c);
}

const ACTIVE = 'restored_at IS NULL AND purged_at IS NULL AND purge_after > now()';

/** Put a deletion back exactly as it was. Only the latest deletion of a record can be undone first. */
export async function restoreTrash(tenant: string, trashId: string) {
  z.uuid().parse(trashId);
  return catalogTransaction(async c => {
    await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
    const item = (await c.query(`SELECT * FROM trash_items WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [trashId, tenant])).rows[0];
    if (!item) throw new CatalogHttpError(404, '回收站里没有这一项');
    if (item.restored_at) throw new CatalogHttpError(409, '已经恢复过了');
    if (item.purged_at || new Date(item.purge_after as Date) <= new Date()) throw new CatalogHttpError(409, '已经彻底删除，不能恢复');
    if (item.feature !== 'listing') throw new CatalogHttpError(400, '这一项还不能在这里恢复');
    const later = await c.query(`SELECT 1 FROM trash_items WHERE tenant_id=$1 AND target_id=$2 AND created_at > $3 AND id<>$4
      AND restored_at IS NULL AND purged_at IS NULL LIMIT 1`, [tenant, item.target_id, item.created_at, trashId]);
    if (later.rowCount) throw new CatalogHttpError(409, '这款后来又删过一次，先恢复后面那次');
    const id = item.target_id as string, state = (item.state ?? {}) as { sourcesClearedAt?: string | null; imagesClearedAt?: string | null; thumb?: string | null };
    if (item.mode === 'all') {
      const p = await c.query('SELECT 1 FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NOT NULL FOR UPDATE', [id, tenant]);
      if (!p.rowCount) throw new CatalogHttpError(409, '这款已经不在回收站里');
      await reclaimFiles(c, tenant, (await c.query('SELECT file_id FROM listing_assets WHERE project_id=$1', [id])).rows.map(r => r.file_id as string));
      await c.query('UPDATE listing_projects SET deleted_at=NULL WHERE id=$1', [id]);
    } else {
      const p = await c.query('SELECT 1 FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, tenant]);
      if (!p.rowCount) throw new CatalogHttpError(409, '这款已经删除，先恢复整款');
      const rows = (await c.query('SELECT file_id FROM listing_assets_trash WHERE trash_id=$1', [trashId])).rows.map(r => r.file_id as string);
      await reclaimFiles(c, tenant, rows);
      const cols = await assetColumns(c);
      await c.query(`WITH back AS (DELETE FROM listing_assets_trash WHERE trash_id=$1 RETURNING *)
        INSERT INTO listing_assets(${cols}) SELECT ${cols} FROM back ON CONFLICT DO NOTHING`, [trashId]);
      await c.query('UPDATE listing_projects SET sources_cleared_at=$2, images_cleared_at=$3 WHERE id=$1',
        [id, state.sourcesClearedAt ?? null, state.imagesClearedAt ?? null]);
      if (state.thumb) {
        const thumb = (await c.query(`DELETE FROM listing_assets WHERE id=$1 AND project_id=$2 AND kind='thumb' RETURNING file_id`, [state.thumb, id])).rows.map(r => r.file_id as string);
        await releaseFiles(c, tenant, thumb);
      }
    }
    await c.query('UPDATE trash_items SET restored_at=now() WHERE id=$1', [trashId]);
    return { ok: true, targetId: id };
  });
}

/** 「立即彻底删除」: no longer restorable; the daily clean-up deletes the files at its next run. */
export async function purgeTrashNow(tenant: string, trashId: string | 'all') {
  if (trashId !== 'all') z.uuid().parse(trashId);
  const result = await catalogDatabase().query(
    `UPDATE trash_items SET purge_after=now() WHERE tenant_id=$1 AND ${ACTIVE} AND ($2::uuid IS NULL OR id=$2::uuid) RETURNING id`,
    [tenant, trashId === 'all' ? null : trashId]);
  if (trashId !== 'all' && !result.rowCount) throw new CatalogHttpError(404, '回收站里没有这一项');
  return { ok: true, purged: result.rowCount };
}

export async function listTrash(tenant: string): Promise<TrashItem[]> {
  const rows = (await catalogDatabase().query(
    `SELECT t.*, NOT EXISTS (SELECT 1 FROM trash_items l WHERE l.tenant_id=t.tenant_id AND l.target_id=t.target_id
        AND l.created_at > t.created_at AND l.restored_at IS NULL AND l.purged_at IS NULL) AS restorable
       FROM trash_items t WHERE t.tenant_id=$1 AND t.${ACTIVE.replaceAll(' AND ', ' AND t.')} ORDER BY t.created_at DESC LIMIT 500`, [tenant])).rows;
  return rows.map(r => ({
    id: r.id as string, feature: r.feature as 'listing' | 'artwork', targetId: r.target_id as string, mode: r.mode as RemoveMode,
    name: r.name as string, bytes: Number(r.bytes), files: Number(r.files),
    createdAt: (r.created_at as Date).toISOString(), purgeAfter: (r.purge_after as Date).toISOString(), restorable: Boolean(r.restorable),
  }));
}
