/** 电商主图 projects and their uploaded images, scoped to one tenant. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { saveCatalogFile, readCatalogFile } from './catalog-files';
import { registerFileRef } from './file-authorization';
import { ASSET_ROLES, countsSchema, shapeOf } from '../listing/layouts';
import { resolveLayout } from './listing-layouts';
import type { ListingPlan } from './listing-plan';

// Users drop a whole product folder; the page shrinks photos to 2048 px before upload, and the
// planning call packs large folders (listing-plan-views), so the limit is only a safety net.
export const MAX_SOURCE_IMAGES = 500;
/** Source images are cleared this long after a product's last image was made. */
export const SOURCE_KEEP_DAYS = 30;
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const assetUrl = (id: string) => `/api/listing/assets/${id}`;

export async function createProject(tenant: string, user: string, input: unknown) {
  const b = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120), layout: z.string(), counts: countsSchema, batchId: z.uuid().optional() }).parse(input);
  if (!(await resolveLayout(tenant, b.layout, { forNewProject: true }))) throw new CatalogHttpError(400, '没有这个版式');
  await catalogDatabase().query(
    `INSERT INTO listing_projects(id,tenant_id,created_by,name,layout,counts,batch_id) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`, [b.id, tenant, user, b.name, b.layout, b.counts, b.batchId ?? null]);
  const row = (await catalogDatabase().query('SELECT tenant_id FROM listing_projects WHERE id=$1', [b.id])).rows[0];
  if (row?.tenant_id !== tenant) throw new CatalogHttpError(409, '商品编号冲突');
  return { id: b.id };
}

/** One uploaded image. Same content uploaded twice to one project keeps the first copy. */
export async function addSourceImage(tenant: string, projectId: string, bytes: Buffer, name: string, relPath: string, allow: string[] = ['uploading']) {
  z.uuid().parse(projectId);
  if (bytes.length > MAX_SOURCE_BYTES) throw new CatalogHttpError(413, '单张图片不能超过 25MB');
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try { meta = await sharp(bytes, { failOn: 'error', limitInputPixels: 60_000_000 }).metadata(); } catch { throw new CatalogHttpError(400, `不是能读取的图片：${name}`); }
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new CatalogHttpError(400, `只支持 JPG、PNG、WebP：${name}`);
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0, height = (rotated ? meta.width : meta.height) ?? 0;
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 400) || name;
  let asset = '';
  await saveCatalogFile(bytes, name.slice(0, 200), 'production', async (c, fileId) => {
    // Locks the tenant row: serialises quota accounting and the per-project limit.
    await c.query('SELECT id FROM tenants WHERE id=$1 AND NOT disabled FOR UPDATE', [tenant]);
    const project = (await c.query('SELECT status FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [projectId, tenant])).rows[0];
    if (!project) throw new CatalogHttpError(404, '商品不存在');
    if (!allow.includes(project.status)) throw new CatalogHttpError(409, '这个商品已经开始分析，不能再加图');
    const existing = (await c.query('SELECT id FROM listing_assets WHERE project_id=$1 AND (rel_path=$2 OR file_id=$3) LIMIT 1', [projectId, rel, fileId])).rows[0];
    if (existing) { asset = existing.id; return; }
    const count = Number((await c.query('SELECT count(*) n FROM listing_assets WHERE project_id=$1', [projectId])).rows[0].n);
    if (count >= MAX_SOURCE_IMAGES) throw new CatalogHttpError(413, `一个商品最多 ${MAX_SOURCE_IMAGES} 张图`);
    const owned = await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [tenant, fileId]);
    if (!owned.rowCount) {
      const updated = await c.query(`UPDATE tenant_usage u SET bytes_used=bytes_used+$2 FROM tenants t
        WHERE u.tenant_id=$1 AND t.id=u.tenant_id AND u.bytes_used+u.bytes_reserved+$2<=t.storage_quota_bytes RETURNING u.tenant_id`, [tenant, bytes.length]);
      if (!updated.rowCount) throw new CatalogHttpError(413, '存储空间不足');
    }
    asset = randomUUID();
    await c.query(`INSERT INTO listing_assets(id,tenant_id,project_id,file_id,kind,name,rel_path,width,height)
      VALUES($1,$2,$3,$4,'source',$5,$6,$7,$8)`, [asset, tenant, projectId, fileId, name.slice(0, 200), rel, width, height]);
    await registerFileRef(fileId, tenant, 'listing-images', name.slice(0, 200), c);
    await c.query('UPDATE listing_projects SET updated_at=now() WHERE id=$1', [projectId]);
  });
  return { id: asset, url: assetUrl(asset), width, height, shape: shapeOf(width, height) };
}

export async function readListingAsset(tenant: string, id: string) {
  z.uuid().parse(id);
  const row = (await catalogDatabase().query('SELECT file_id FROM listing_assets WHERE id=$1 AND tenant_id=$2', [id, tenant])).rows[0];
  if (!row) throw new CatalogHttpError(404, '图片不存在');
  return readCatalogFile(row.file_id);
}

/** Images in a stable order; the plan refers to them as M1, M2, … in this order. */
export async function sourceImages(projectId: string) {
  const rows = (await catalogDatabase().query(
    `SELECT id,file_id,name,rel_path,width,height FROM listing_assets WHERE project_id=$1 AND kind='source'`, [projectId])).rows as
    { id: string; file_id: string; name: string; rel_path: string; width: number; height: number }[];
  rows.sort((a, b) => a.rel_path.localeCompare(b.rel_path, 'zh', { numeric: true }));
  return rows.map((row, i) => ({ ...row, label: `M${i + 1}`, shape: shapeOf(row.width, row.height) }));
}

type ProjectRow = { id: string; name: string; layout: string; counts: unknown; status: string; plan: StoredPlan | null; review: Review | null; error: string | null; created_at: string; updated_at: string; confirmed_at: string | null };
/** `direct`: colours whose own image is used as the white-background product image (no paid extraction). */
export type StoredPlan = { plan: ListingPlan; corrected: string[]; problems: string[]; model: string; direct?: string[] };

export async function listProjects(tenant: string) {
  const rows = (await catalogDatabase().query(
    `SELECT p.id,p.name,p.layout,p.counts,p.status,p.error,p.updated_at,p.created_at,p.sources_cleared_at,p.batch_id,
            (SELECT count(*)::int FROM listing_assets a WHERE a.project_id=p.id AND a.kind='source') AS images,
            COALESCE((SELECT a.id FROM listing_assets a WHERE a.project_id=p.id AND a.slot='square:1' ORDER BY a.created_at DESC LIMIT 1),
                     (SELECT a.id FROM listing_assets a WHERE a.project_id=p.id AND a.kind='source' ORDER BY a.rel_path LIMIT 1)) AS cover,
            (SELECT count(DISTINCT j.slot)::int FROM listing_jobs j WHERE j.project_id=p.id AND j.slot IS NOT NULL) AS slots,
            (SELECT count(DISTINCT a.slot)::int FROM listing_assets a WHERE a.project_id=p.id AND a.slot IS NOT NULL) AS made,
            (SELECT count(*)::int FROM (SELECT DISTINCT ON (j.slot) j.status, j.slot FROM listing_jobs j WHERE j.project_id=p.id AND j.slot IS NOT NULL
               ORDER BY j.slot, j.created_at DESC) latest
               WHERE latest.status IN ('failed','unknown') AND NOT EXISTS (SELECT 1 FROM listing_assets a WHERE a.project_id=p.id AND a.slot=latest.slot)) AS broken
       FROM listing_projects p WHERE p.tenant_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 200`, [tenant])).rows;
  return rows.map(r => ({ ...r, cover: r.cover ? assetUrl(r.cover) : null }));
}

export async function projectDetail(tenant: string, id: string) {
  z.uuid().parse(id);
  const p = (await catalogDatabase().query(
    `SELECT id,name,layout,counts,status,plan,review,materials,error,created_at,updated_at,confirmed_at FROM listing_projects
      WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`, [id, tenant])).rows[0] as ProjectRow | undefined;
  if (!p) throw new CatalogHttpError(404, '商品不存在');
  const images = (await sourceImages(id)).map(({ id: assetId, label, name, rel_path, width, height, shape }) =>
    ({ id: assetId, label, name, path: rel_path, width, height, shape, url: assetUrl(assetId) }));
  return { ...p, images };
}

/** What one main image says and shows; the user can change all of it. No scene: keep the AI's. */
export const slotWordsSchema = z.object({
  title: z.string().trim().min(1, '大标题不能空').max(20), subtitle: z.string().trim().max(30).default(''),
  bullets: z.array(z.string().trim().max(16)).max(3).default([]).transform(b => b.filter(Boolean)),
  scene: z.string().trim().max(400).optional(),
});
export type SlotWords = z.infer<typeof slotWordsSchema>;
const reviewSchema = z.object({
  roles: z.record(z.string(), z.enum(ASSET_ROLES)).default({}),
  colors: z.array(z.object({ sku: z.string(), name: z.string().trim().min(1).max(20) })).default([]),
  // Each main image's words and picture, keyed by slot ("square:1", "portrait:2", "poster:1").
  slots: z.record(z.string().regex(/^(square|portrait|poster):\d$/), slotWordsSchema).default({}),
});
export type Review = z.infer<typeof reviewSchema>;

/** The user's corrections to the sorting, colour names and image words; nothing is paid here. */
export async function saveReview(tenant: string, id: string, input: unknown) {
  const review = reviewSchema.parse(input);
  const updated = await catalogDatabase().query(
    `UPDATE listing_projects SET review=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='review' AND deleted_at IS NULL RETURNING id`,
    [id, tenant, review]);
  if (!updated.rowCount) throw new CatalogHttpError(409, '只有等你确认的商品可以修改');
  return { ok: true };
}

export async function confirmProject(tenant: string, id: string) {
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status,plan,review FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id, tenant])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (p.status === 'confirmed') return { ok: true };
    if (p.status !== 'review') throw new CatalogHttpError(409, '还没有分析完，不能确认');
    const stored = p.plan as StoredPlan;
    const review = (p.review ?? {}) as Partial<Review>;
    const roles = new Map(stored.plan.assets.map(a => [a.id, review.roles?.[a.id] ?? a.role]));
    const missing = stored.plan.product.colors.filter(color => roles.get(color.sku) !== 'SKU');
    if (missing.length) throw new CatalogHttpError(409, `颜色「${missing.map(c => c.name).join('、')}」对应的图被改成了非 SKU，请改回或换一张`);
    await c.query(`UPDATE listing_projects SET status='confirmed', confirmed_at=now(), updated_at=now() WHERE id=$1`, [id]);
    return { ok: true };
  });
}

/**
 * Give back the storage of files this tenant no longer uses: a file still shown by another of its
 * products, or held by another feature, keeps counting. The objects themselves stay in storage.
 */
async function releaseFiles(c: CatalogQueryClient, tenant: string, fileIds: string[]) {
  let freed = 0;
  for (const fileId of new Set(fileIds)) {
    const used = await c.query(`SELECT 1 FROM listing_assets a JOIN listing_projects p ON p.id=a.project_id
      WHERE a.tenant_id=$1 AND a.file_id=$2 AND p.deleted_at IS NULL LIMIT 1`, [tenant, fileId]);
    if (used.rowCount) continue;
    await c.query(`DELETE FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 AND purpose='listing-images'`, [tenant, fileId]);
    if ((await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [tenant, fileId])).rowCount) continue;
    const size = Number((await c.query('SELECT byte_length FROM files WHERE id=$1', [fileId])).rows[0]?.byte_length ?? 0);
    await c.query('UPDATE tenant_usage SET bytes_used=GREATEST(bytes_used-$2,0) WHERE tenant_id=$1', [tenant, size]);
    freed += size;
  }
  return freed;
}

/** Deleting a product hides it and gives its storage back. */
export async function deleteProject(tenant: string, id: string) {
  z.uuid().parse(id);
  return catalogTransaction(async c => {
    await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
    const running = await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND tenant_id=$2 AND status IN ('queued','running') LIMIT 1`, [id, tenant]);
    if (running.rowCount) throw new CatalogHttpError(409, '正在分析或出图，等完成后再删除');
    const result = await c.query('UPDATE listing_projects SET deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING id', [id, tenant]);
    if (!result.rowCount) throw new CatalogHttpError(404, '商品不存在');
    const files = (await c.query('SELECT file_id FROM listing_assets WHERE project_id=$1', [id])).rows.map(r => r.file_id as string);
    return { ok: true, freedBytes: await releaseFiles(c, tenant, files) };
  });
}

/**
 * Products whose last image was made SOURCE_KEEP_DAYS ago lose their uploaded images (the
 * generated ones stay) and the storage is given back. Run by the workers; one at a time.
 */
export async function clearOldSources(limit = 20) {
  return catalogTransaction(async c => {
    if (!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext('listing-clear-sources')) AS ok")).rows[0].ok) return 0;
    const due = (await c.query(`SELECT id,tenant_id FROM listing_projects WHERE status='done' AND deleted_at IS NULL AND sources_cleared_at IS NULL
      AND updated_at < now() - make_interval(days => $1) ORDER BY updated_at LIMIT $2`, [SOURCE_KEEP_DAYS, limit])).rows as { id: string; tenant_id: string }[];
    for (const p of due) {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [p.tenant_id]);
      const files = (await c.query(`DELETE FROM listing_assets WHERE project_id=$1 AND kind='source' RETURNING file_id`, [p.id])).rows.map(r => r.file_id as string);
      await releaseFiles(c, p.tenant_id, files);
      await c.query('UPDATE listing_projects SET sources_cleared_at=now() WHERE id=$1', [p.id]);
    }
    return due.length;
  });
}

/** A generated image: one row per version, the newest per slot is the current one. */
export async function storeOutput(tenant: string, projectId: string, slot: string, jobId: string, bytes: Buffer) {
  const meta = await sharp(bytes, { failOn: 'error' }).metadata();
  if (!meta.width || !meta.height) throw new Error('出图结果不是有效图片');
  const kind = slot.startsWith('product:') ? 'product' : 'output', name = `${slot.replace(':', '-')}.${meta.format ?? 'png'}`;
  let asset = '';
  await saveCatalogFile(bytes, name, 'production', async (c, fileId) => {
    await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
    const owned = await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [tenant, fileId]);
    // Results are already paid for: they are kept even when the storage quota is exceeded.
    if (!owned.rowCount) await c.query('UPDATE tenant_usage SET bytes_used=bytes_used+$2 WHERE tenant_id=$1', [tenant, bytes.length]);
    asset = randomUUID();
    await c.query(`INSERT INTO listing_assets(id,tenant_id,project_id,file_id,kind,name,rel_path,width,height,slot,job_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [asset, tenant, projectId, fileId, kind, name, `${slot}#${jobId}`, meta.width, meta.height, slot, jobId]);
    await registerFileRef(fileId, tenant, 'listing-images', name, c);
  });
  return asset;
}

/** Current image per slot: the version the user went back to, unless a newer one was made since. */
export async function latestOutputs(projectId: string) {
  const rows = (await catalogDatabase().query(
    `SELECT DISTINCT ON (slot) id,slot,file_id,name,width,height,created_at FROM listing_assets
      WHERE project_id=$1 AND slot IS NOT NULL ORDER BY slot, GREATEST(created_at, COALESCE(chosen_at, created_at)) DESC`, [projectId])).rows as { id: string; slot: string; file_id: string; name: string; width: number; height: number }[];
  return new Map(rows.map(row => [row.slot, row]));
}

/** Go back to an earlier version of a main image; downloads and the page use it from now on. */
export async function chooseVersion(tenant: string, projectId: string, slot: string, assetId: string) {
  z.uuid().parse(assetId);
  if (!/^(square|portrait|poster):\d$/.test(slot)) throw new CatalogHttpError(400, '只有主图和海报能换版本');
  const updated = await catalogDatabase().query(`UPDATE listing_assets SET chosen_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND slot=$4 RETURNING id`, [assetId, tenant, projectId, slot]);
  if (!updated.rowCount) throw new CatalogHttpError(404, '没有这个版本');
  return { ok: true };
}
