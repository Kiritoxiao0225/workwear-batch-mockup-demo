/** 电商主图 projects and their uploaded images, scoped to one tenant. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { saveCatalogFile, readCatalogFile, fileSha256 } from './catalog-files';
import { assertStorageRoom, STORAGE_FULL } from './quota';
import { registerFileRef } from './file-authorization';
import { shapeOf } from '../listing/templates';
import { countsSchema, type SubmittedDraft } from '../listing/draft-schema';
import { resolveLayout } from './listing-layouts';

// Users drop a whole product folder; the page shrinks photos to 2048 px before upload, and the
// planning call packs large folders (listing-plan-views), so the limit is only a safety net.
export const MAX_SOURCE_IMAGES = 500;
/** Source images are cleared this long after a product's last image was made. */
export const SOURCE_KEEP_DAYS = 30;
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const assetUrl = (id: string) => `/api/listing/assets/${id}`;

export async function createProject(tenant: string, user: string, input: unknown) {
  const b = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120), layout: z.string(), counts: countsSchema }).parse(input);
  if (!(await resolveLayout(tenant, b.layout, { forNewProject: true }))) throw new CatalogHttpError(400, '没有这个版式');
  await catalogDatabase().query(
    `INSERT INTO listing_projects(id,tenant_id,created_by,name,layout,counts) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO NOTHING`, [b.id, tenant, user, b.name, b.layout, b.counts]);
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
  await assertStorageRoom(tenant, bytes.length, fileSha256(bytes));
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
      if (!updated.rowCount) throw new CatalogHttpError(413, STORAGE_FULL);
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

type ProjectRow = { id: string; name: string; layout: string; counts: unknown; status: string; plan: StoredPlan | null; materials: unknown; error: string | null; created_at: string; updated_at: string };
/**
 * What a product is generated from: the plan the user started (`draft`, with the square images'
 * words as the 画板 left them), the model's garment description and each image's scene. `colors`
 * start with the main colour; `sku` is the colour's key (colorKeys: its garment image's label). `direct`: colours
 * whose own image is the product image. `round`: 1 after 「开始出图」, 2 after 「出竖版」.
 */
export type StoredPlan = {
  draft: SubmittedDraft; garment: string[]; scenes: Record<string, string>; sku: { tag: string; fabric: string };
  colors: { name: string; hex: string; sku: string }[]; direct: string[]; images: { label: string; assetId: string }[]; model: string; round: 1 | 2;
  /** The material's own model photo of a colour, for its SKU image (colour label → photo label); the other colours' models are drawn. */
  photos?: Record<string, string>;
  /** A colour drawn from a photo of several garments (colour key → the colour to take from it); none before 10-16. */
  sourceSelections?: Record<string, string>;
  /** Where the SKU models and the closer's group are photographed, the same for the whole set (the writing step's); none before 10-16. */
  place?: string;
};

/**
 * The shop an image of a product is for (10-22): a cover in another colour (slot `…+<sku>`) may name
 * its own in 换色首图, else the product's; none: the account's default shop.
 */
export function slotShop(stored: Pick<StoredPlan, 'draft' | 'colors'> | null | undefined, slot: string): string | undefined {
  const sku = slot.split('+')[1], d = stored?.draft;
  const extra = sku ? d?.extra.find(e => stored?.colors.find(c => c.name === e.color)?.sku === sku) : undefined;
  return extra?.shop ?? d?.shop;
}

/**
 * The newest 「点图修改」 of each slot of the product `project` (an SQL expression), and whether it still
 * waits for the user (`open`): it is queued or being drawn, or it made a new image not adopted, or it
 * failed, either newer than the image shown. Adopting a version, or keeping the shown one (choosing it
 * again), closes it.
 */
export const latestRedraws = (project: string) => `SELECT DISTINCT ON (j.slot) j.id, j.slot, j.status, j.error, j.retries, j.retry_at, j.input->>'ask' AS ask, j.created_at, j.updated_at, j.result_asset,
    CASE WHEN j.status IN ('queued','running') THEN true
      WHEN j.status = 'succeeded' THEN EXISTS (SELECT 1 FROM listing_assets r WHERE r.id=j.result_asset AND r.chosen_at IS NULL AND r.created_at > COALESCE(cur.at, '-infinity'))
      ELSE j.updated_at > COALESCE(cur.at, '-infinity') END AS open
  FROM listing_jobs j
  LEFT JOIN LATERAL (SELECT max(GREATEST(a.created_at, COALESCE(a.chosen_at, a.created_at))) AS at FROM listing_assets a
    WHERE a.project_id=j.project_id AND a.slot=j.slot AND (NOT a.candidate OR a.chosen_at IS NOT NULL)) cur ON true
  WHERE j.project_id=${project} AND j.input->>'kind'='redraw' ORDER BY j.slot, j.created_at DESC`;

export async function listProjects(tenant: string) {
  const rows = (await catalogDatabase().query(
    `SELECT p.id,p.name,p.layout,p.counts,p.status,p.error,p.updated_at,p.created_at,p.sources_cleared_at,COALESCE((p.plan->>'round')::int,0) AS round,
            (SELECT count(*)::int FROM listing_assets a WHERE a.project_id=p.id AND a.kind='source') AS images,
            COALESCE((SELECT a.id FROM listing_assets a WHERE a.project_id=p.id AND a.slot='square:1' AND (NOT a.candidate OR a.chosen_at IS NOT NULL) ORDER BY GREATEST(a.created_at, COALESCE(a.chosen_at, a.created_at)) DESC LIMIT 1),
                     (SELECT a.id FROM listing_assets a WHERE a.project_id=p.id AND a.kind='source' ORDER BY a.rel_path LIMIT 1)) AS cover,
            (SELECT count(DISTINCT j.slot)::int FROM listing_jobs j WHERE j.project_id=p.id AND j.slot IS NOT NULL) AS slots,
            (SELECT count(DISTINCT a.slot)::int FROM listing_assets a WHERE a.project_id=p.id AND a.slot IS NOT NULL) AS made,
            (SELECT count(*)::int FROM (SELECT DISTINCT ON (j.slot) j.status, j.slot FROM listing_jobs j WHERE j.project_id=p.id AND j.slot IS NOT NULL
               ORDER BY j.slot, j.created_at DESC) latest
               WHERE latest.status IN ('failed','unknown') AND NOT EXISTS (SELECT 1 FROM listing_assets a WHERE a.project_id=p.id AND a.slot=latest.slot)) AS broken,
            (SELECT json_build_object('running', count(*) FILTER (WHERE r.status IN ('queued','running')), 'ready', count(*) FILTER (WHERE r.status='succeeded' AND r.open),
               'failed', count(*) FILTER (WHERE r.status IN ('failed','unknown') AND r.open)) FROM (${latestRedraws('p.id')}) r) AS edits
       FROM listing_projects p WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.kind='product' ORDER BY p.created_at DESC LIMIT 200`, [tenant])).rows;
  return rows.map(r => ({ ...r, cover: r.cover ? assetUrl(r.cover) : null }));
}

export async function projectDetail(tenant: string, id: string) {
  z.uuid().parse(id);
  const p = (await catalogDatabase().query(
    `SELECT id,name,layout,counts,status,plan,materials,error,created_at,updated_at FROM listing_projects
      WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`, [id, tenant])).rows[0] as ProjectRow | undefined;
  if (!p) throw new CatalogHttpError(404, '商品不存在');
  const sources = (await sourceImages(id)).map(({ id: assetId, label, name, rel_path, shape }) => ({ id: assetId, label, name, path: rel_path, shape }));
  // The page reads the plan as the user's draft (with the 画板's changes), and the round it is in.
  return { ...p, plan: p.plan?.draft ?? null, round: p.plan?.round ?? 0, images: sources.length, sources };
}

/** A main image's slot: `square:2`, `long:1`, or a cover of an extra colour set, `square:1+M23`; on the shop's row, `service:A-light` (another shop's `service:s1a2b3c4d~A-light`). */
export const MAIN_SLOT = /^((square|portrait|long):\d(\+\w+)?|service:(s[0-9a-f]{8}~)?[A-Za-z-]{1,12})$/;

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
    const result = await c.query(`UPDATE listing_projects SET deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL AND kind='product' RETURNING id`, [id, tenant]);
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
    const due = (await c.query(`SELECT id,tenant_id FROM listing_projects WHERE status IN ('square','done') AND deleted_at IS NULL AND sources_cleared_at IS NULL
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

/**
 * A generated image: one row per version, the newest per slot is the current one. A `candidate`
 * (from 「点图修改」) is only a version until the user adopts it.
 */
export async function storeOutput(tenant: string, projectId: string, slot: string, jobId: string, bytes: Buffer, candidate = false) {
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
    await c.query(`INSERT INTO listing_assets(id,tenant_id,project_id,file_id,kind,name,rel_path,width,height,slot,job_id,candidate)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [asset, tenant, projectId, fileId, kind, name, `${slot}#${jobId}`, meta.width, meta.height, slot, jobId, candidate]);
    await registerFileRef(fileId, tenant, 'listing-images', name, c);
  });
  return asset;
}

/** Current image per slot: the version the user went back to, unless a newer one was made since. */
export async function latestOutputs(projectId: string) {
  const rows = (await catalogDatabase().query(
    `SELECT DISTINCT ON (slot) id,slot,file_id,name,width,height,created_at FROM listing_assets
      WHERE project_id=$1 AND slot IS NOT NULL AND (NOT candidate OR chosen_at IS NOT NULL) ORDER BY slot, GREATEST(created_at, COALESCE(chosen_at, created_at)) DESC`, [projectId])).rows as { id: string; slot: string; file_id: string; name: string; width: number; height: number }[];
  return new Map(rows.map(row => [row.slot, row]));
}

/** Go back to an earlier version of a main image; downloads and the page use it from now on. */
export async function chooseVersion(tenant: string, projectId: string, slot: string, assetId: string) {
  z.uuid().parse(assetId);
  if (!MAIN_SLOT.test(slot)) throw new CatalogHttpError(400, '只有主图和服务图能换版本');
  const updated = await catalogDatabase().query(`UPDATE listing_assets SET chosen_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND slot=$4 RETURNING id`, [assetId, tenant, projectId, slot]);
  if (!updated.rowCount) throw new CatalogHttpError(404, '没有这个版本');
  return { ok: true };
}

/**
 * An image the user adds to 「点图修改」 to show what they want (a background, a pose). Kept with the
 * product (kind 'ref') so the job can read it; it is never shown as one of the product's images.
 */
export async function addReference(tenant: string, projectId: string, bytes: Buffer, name: string) {
  z.uuid().parse(projectId);
  if (bytes.length > MAX_SOURCE_BYTES) throw new CatalogHttpError(413, '单张图片不能超过 25MB');
  let png: Buffer, width: number, height: number;
  try {
    const out = await sharp(bytes, { failOn: 'error', limitInputPixels: 60_000_000 }).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    png = out.data; width = out.info.width; height = out.info.height;
  } catch { throw new CatalogHttpError(400, `不是能读取的图片：${name}`); }
  await assertStorageRoom(tenant, png.length, fileSha256(png));
  let asset = '';
  await saveCatalogFile(png, `参考-${name.slice(0, 100)}.png`, 'production', async (c, fileId) => {
    await c.query('SELECT id FROM tenants WHERE id=$1 AND NOT disabled FOR UPDATE', [tenant]);
    if (!(await c.query('SELECT 1 FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [projectId, tenant])).rowCount) throw new CatalogHttpError(404, '商品不存在');
    const owned = await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [tenant, fileId]);
    if (!owned.rowCount) {
      const updated = await c.query(`UPDATE tenant_usage u SET bytes_used=bytes_used+$2 FROM tenants t
        WHERE u.tenant_id=$1 AND t.id=u.tenant_id AND u.bytes_used+u.bytes_reserved+$2<=t.storage_quota_bytes RETURNING u.tenant_id`, [tenant, png.length]);
      if (!updated.rowCount) throw new CatalogHttpError(413, STORAGE_FULL);
    }
    asset = randomUUID();
    await c.query(`INSERT INTO listing_assets(id,tenant_id,project_id,file_id,kind,name,rel_path,width,height) VALUES($1,$2,$3,$4,'ref',$5,$6,$7,$8)`,
      [asset, tenant, projectId, fileId, name.slice(0, 200), `参考/${asset}`, width, height]);
    await registerFileRef(fileId, tenant, 'listing-images', name.slice(0, 200), c);
  });
  return { asset };
}
