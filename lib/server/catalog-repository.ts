import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { alignmentSchema, projectStandard, assertConfirmedStandard, boxSchema, standardSchema, type CatalogStyle, type CatalogDetail, type CatalogItem, type CatalogUser, type StandardVersion } from '@/lib/catalog';
import { calibrationFaceSchema } from '@/lib/catalog-calibration-status';
import { CatalogHttpError } from './catalog-auth';
import { catalogDatabase, catalogTransaction } from './catalog-database';

const idSchema = z.uuid();
const querySchema = z.object({ q: z.string().max(100).default(''), page: z.coerce.number().int().min(1).default(1), status: z.enum(['all', 'confirmed', 'pending', 'draft', 'front_only']).default('all') });
const itemSelect = `SELECT v.id,s.id AS style_id,s.reference_variant_id,s.style_code,s.source_namespace,v.color_name,a.id AS asset_id,a.version,a.layout,
  f.id AS file_id,f.original_name,f.width,f.height,f.sha256,a.thumbnail_file_id,
  (SELECT count(*)::int FROM garment_views g WHERE g.asset_version_id=a.id) AS face_count,
  (SELECT count(*)::int FROM garment_views g WHERE g.asset_version_id=a.id AND g.confirmed_standard_id IS NOT NULL) AS confirmed_faces,
  EXISTS(SELECT 1 FROM garment_views g JOIN placement_standard_versions p ON p.id=g.latest_standard_id WHERE g.asset_version_id=a.id AND p.status='draft') AS has_draft,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'face',g.face,'status',CASE WHEN p.id IS NULL THEN 'unmarked' WHEN p.status='confirmed' AND p.id=g.confirmed_standard_id THEN 'confirmed' ELSE 'draft' END,
    'positions',COALESCE((SELECT jsonb_agg(position->>'key') FROM jsonb_array_elements(COALESCE(src.specification,p.specification)->'positions') position),'[]'::jsonb),
    'confirmedPositions',COALESCE((SELECT jsonb_agg(position->>'key') FROM jsonb_array_elements(COALESCE(cs.specification,c.specification)->'positions') position),'[]'::jsonb),
    'origin',p.origin) ORDER BY CASE g.face WHEN 'front' THEN 0 ELSE 1 END),'[]'::jsonb)
   FROM garment_views g LEFT JOIN placement_standard_versions p ON p.id=g.latest_standard_id
   LEFT JOIN placement_standard_versions src ON src.id=p.source_standard_id
   LEFT JOIN placement_standard_versions c ON c.id=g.confirmed_standard_id
   LEFT JOIN placement_standard_versions cs ON cs.id=c.source_standard_id
   WHERE g.asset_version_id=a.id) AS calibration_faces
  FROM garment_variants v JOIN garment_styles s ON s.id=v.style_id JOIN garment_asset_versions a ON a.id=v.current_asset_version_id JOIN files f ON f.id=a.file_id`;
/**
 * Every catalog read is scoped to one tenant, and the tenant is always `$1`. Callers must pass
 * it explicitly: a default would let a forgotten call site quietly read another tenant's data.
 */
const scoped = (extra = '') => `${itemSelect} WHERE s.tenant_id=$1${extra ? ` AND ${extra}` : ''}`;
function mapItem(row: Record<string, unknown>): CatalogItem {
  return z.object({ id: z.uuid(), styleId: z.uuid(), styleCode: z.string(), colorName: z.string(), namespace: z.string(), assetVersionId: z.uuid(), assetVersion: z.number().int().positive(), filename: z.string(), imageUrl: z.string(), thumbnailUrl: z.string(), width: z.number().positive(), height: z.number().positive(), layout: z.enum(['front_back', 'front_only']), sha256: z.string().regex(/^[0-9a-f]{64}$/), confirmedFaces: z.number().int(), faceCount: z.number().int(), hasDraft: z.boolean(), calibrationFaces: z.array(calibrationFaceSchema) }).parse({
    id: row.id, styleId: row.style_id, styleCode: row.style_code, colorName: row.color_name, namespace: row.source_namespace, assetVersionId: row.asset_id, assetVersion: row.version,
    filename: row.original_name, imageUrl: `/api/catalog/files/${row.file_id}`, thumbnailUrl: `/api/catalog/files/${row.thumbnail_file_id}`,
    width: row.width, height: row.height, layout: row.layout, sha256: row.sha256, confirmedFaces: row.confirmed_faces, faceCount: row.face_count, hasDraft: row.has_draft, calibrationFaces: row.calibration_faces,
  });
}
function mapStandard(row: Record<string, unknown>): StandardVersion {
  const inherited = row.origin === 'inherited';
  return { id: idSchema.parse(row.id), revision: z.number().int().positive().parse(row.revision), status: z.enum(['draft', 'confirmed']).parse(row.status), specification: inherited ? projectStandard(standardSchema.parse(row.source_specification), alignmentSchema.parse(row.alignment)) : standardSchema.parse(row.specification), createdBy: z.string().parse(row.display_name), createdAt: z.date().parse(row.created_at).toISOString(), origin: z.enum(['manual', 'inherited', 'model']).parse(row.origin),
    ...(inherited ? { source: { id: idSchema.parse(row.source_standard_id), colorName: z.string().parse(row.source_color), revision: z.number().int().positive().parse(row.source_revision) } } : {}),
  };
}

function statusFilter(status: string) {
  return status === 'confirmed' ? 'confirmed_faces=face_count AND face_count>0 AND NOT has_draft' : status === 'pending' ? '(confirmed_faces<face_count OR has_draft)' : status === 'draft' ? 'has_draft' : status === 'front_only' ? "layout='front_only'" : 'true';
}
function mapStyle(rows: Record<string, unknown>[], matchedIds?: string[]): CatalogStyle {
  const colors = rows.map(mapItem); const first = colors[0];
  return { id: first.styleId, styleCode: first.styleCode, namespace: first.namespace, referenceVariantId: idSchema.nullable().parse(rows[0].reference_variant_id), colors, matchedIds: matchedIds ?? colors.map(c => c.id) };
}
export async function catalogStyle(styleId: string, tenantId: string): Promise<CatalogStyle> {
  idSchema.parse(styleId);
  const result = await catalogDatabase().query(`${scoped('s.id=$2')} ORDER BY v.color_name,v.id`, [tenantId, styleId]);
  if (!result.rowCount) throw new CatalogHttpError(404, `找不到款式：${styleId}`);
  return mapStyle(result.rows);
}
/** Production selectors need all styles, not page counts and import diagnostics. */
export async function allCatalogStyles(tenantId: string): Promise<CatalogStyle[]> {
  const result = await catalogDatabase().query(`${scoped()} ORDER BY s.style_code,s.id,v.color_name,v.id`, [tenantId]);
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of result.rows) {
    const rows = grouped.get(row.style_id) ?? [];
    rows.push(row); grouped.set(row.style_id, rows);
  }
  return [...grouped.values()].map(rows => mapStyle(rows));
}
export async function listCatalogStyles(raw: unknown, tenantId: string) {
  const query = querySchema.parse(raw);
  const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
  const filtered = `WITH items AS (${scoped()}) SELECT * FROM items WHERE (style_code ILIKE $2 OR color_name ILIKE $2) AND (${statusFilter(query.status)})`;
  // One metadata round trip; opening extra connections in parallel was slower
  // on a cold remote pool. The next read only fetches colors for this style page.
  const metadata = (await catalogDatabase().query(`WITH matched AS (${filtered}),
    selected AS (SELECT style_id,array_agg(id) AS matches,min(style_code) AS code FROM matched GROUP BY style_id ORDER BY code,style_id LIMIT 24 OFFSET $3),
    latest_imports AS (SELECT DISTINCT ON (i.filename) i.filename,i.status,i.error FROM import_items i
      JOIN import_batches ib ON ib.id=i.batch_id WHERE ib.tenant_id=$1 ORDER BY i.filename,i.updated_at DESC),
    import_issues AS (SELECT filename,status,error FROM latest_imports WHERE status IN ('quarantined','failed')
      UNION SELECT DISTINCT issue->>'path' AS filename,'missing_source' AS status,issue->>'issue' AS error
      FROM import_batches b CROSS JOIN LATERAL jsonb_array_elements(b.manifest->'sourceIssues') issue
      WHERE b.tenant_id=$1 LIMIT 100)
    SELECT count(DISTINCT style_id)::int AS total,count(*)::int AS matching_colors,
      (SELECT count(*)::int FROM garment_variants v JOIN garment_asset_versions a ON a.id=v.current_asset_version_id WHERE v.style_id IN (SELECT style_id FROM matched)) AS total_colors,
      COALESCE((SELECT jsonb_agg(selected ORDER BY code,style_id) FROM selected),'[]'::jsonb) AS selected,
      COALESCE((SELECT jsonb_agg(import_issues) FROM import_issues),'[]'::jsonb) AS import_issues
    FROM matched`, [tenantId, pattern, (query.page - 1) * 24])).rows[0];
  const selected = z.array(z.object({ style_id: idSchema, matches: z.array(idSchema) })).parse(metadata.selected);
  const styleIds = selected.map(row => row.style_id);
  const colors = await catalogDatabase().query(`${scoped('s.id=ANY($2::uuid[])')} ORDER BY s.id,v.color_name,v.id`, [tenantId, styleIds]);
  const styles = selected.map(row => mapStyle(colors.rows.filter(color => color.style_id === row.style_id), row.matches));
  return { items: styles, total: z.number().int().parse(metadata.total), totalColors: z.number().int().parse(metadata.total_colors), matchingColors: z.number().int().parse(metadata.matching_colors), page: query.page, pageSize: 24, importIssues: z.array(z.object({ filename: z.string(), status: z.string(), error: z.string() })).parse(metadata.import_issues) };
}
export async function listCatalog(raw: unknown, tenantId: string) {
  const query = querySchema.parse(raw);
  const filter = query.status === 'confirmed' ? 'confirmed_faces=face_count AND face_count>0 AND NOT has_draft'
    : query.status === 'pending' ? '(confirmed_faces<face_count OR has_draft)' : query.status === 'draft' ? 'has_draft'
      : query.status === 'front_only' ? "layout='front_only'" : 'true';
  const base = `WITH items AS (${scoped('(s.style_code ILIKE $2 OR v.color_name ILIKE $2 OR s.name ILIKE $2)')}) SELECT * FROM items WHERE ${filter}`;
  const values = [tenantId, `%${query.q.replace(/[\\%_]/g, '\\$&')}%`];
  const [rows, count, imports] = await Promise.all([
    catalogDatabase().query(`${base} ORDER BY style_code,color_name,id LIMIT 30 OFFSET $3`, [...values, (query.page - 1) * 30]),
    catalogDatabase().query(`SELECT count(*)::int AS total FROM (${base}) counted`, values),
    catalogDatabase().query(`WITH latest AS (SELECT DISTINCT ON (i.filename) i.filename,i.status,i.error FROM import_items i
      JOIN import_batches ib ON ib.id=i.batch_id WHERE ib.tenant_id=$1 ORDER BY i.filename,i.updated_at DESC)
      SELECT filename,status,error FROM latest WHERE status IN ('quarantined','failed')
      UNION SELECT DISTINCT issue->>'path' AS filename,'missing_source' AS status,issue->>'issue' AS error
      FROM import_batches b CROSS JOIN LATERAL jsonb_array_elements(b.manifest->'sourceIssues') issue
      WHERE b.tenant_id=$1 LIMIT 100`, [tenantId]),
  ]);
  return { items: rows.rows.map(mapItem), total: count.rows[0].total as number, page: query.page, pageSize: 30, importIssues: imports.rows as { filename: string; status: string; error: string }[] };
}
export async function catalogDetail(variantId: string, assetVersionId: string | undefined, tenantId: string): Promise<CatalogDetail> {
  idSchema.parse(variantId);
  if (assetVersionId) idSchema.parse(assetVersionId);
  const detailSelect = itemSelect.replace('SELECT v.id,', 'SELECT a.provenance,v.current_asset_version_id,v.id,');
  const select = assetVersionId ? detailSelect.replace('a.id=v.current_asset_version_id', 'a.id=$3 AND a.variant_id=v.id') : detailSelect;
  const rows = await catalogDatabase().query(`${select} WHERE s.tenant_id=$1 AND v.id=$2`, assetVersionId ? [tenantId, variantId, assetVersionId] : [tenantId, variantId]);
  if (!rows.rowCount) throw new CatalogHttpError(404, `找不到颜色款：${variantId}`);
  const item = mapItem(rows.rows[0]);
  const [views, standards, sources, versions] = await Promise.all([
    catalogDatabase().query("SELECT * FROM garment_views WHERE asset_version_id=$1 ORDER BY CASE face WHEN 'front' THEN 0 ELSE 1 END", [item.assetVersionId]),
    catalogDatabase().query('SELECT p.*,u.display_name,src.specification AS source_specification,src.revision AS source_revision,sv.color_name AS source_color FROM placement_standard_versions p JOIN users u ON u.id=p.created_by JOIN garment_views g ON g.id=p.view_id LEFT JOIN placement_standard_versions src ON src.id=p.source_standard_id LEFT JOIN garment_views sg ON sg.id=src.view_id LEFT JOIN garment_asset_versions sa ON sa.id=sg.asset_version_id LEFT JOIN garment_variants sv ON sv.id=sa.variant_id WHERE g.asset_version_id=$1 ORDER BY p.revision DESC', [item.assetVersionId]),
    catalogDatabase().query('SELECT f.id,f.original_name FROM asset_sources a JOIN files f ON f.id=a.file_id WHERE a.asset_version_id=$1', [item.assetVersionId]),
    catalogDatabase().query('SELECT a.id,a.version,a.created_at,f.sha256 FROM garment_asset_versions a JOIN files f ON f.id=a.file_id WHERE a.variant_id=$1 ORDER BY a.version DESC', [variantId]),
  ]);
  return { ...item, isCurrent: rows.rows[0].current_asset_version_id === item.assetVersionId, provenance: rows.rows[0].provenance, sources: sources.rows.map(s => ({ filename: s.original_name, url: `/api/catalog/files/${s.id}` })),
    versions: versions.rows.map(v => ({ id: v.id, version: v.version, createdAt: v.created_at.toISOString(), sha256: v.sha256 })),
    views: views.rows.map(view => {
      const history = standards.rows.filter(s => s.view_id === view.id).map(mapStandard);
      return { id: view.id, face: view.face, crop: boxSchema.parse(view.crop), revision: view.revision, latest: history.find(s => s.id === view.latest_standard_id) ?? null, confirmedId: view.confirmed_standard_id, history };
    }),
  };
}
export const saveStandardSchema = z.object({ viewId: z.uuid(), assetVersionId: z.uuid(), expectedRevision: z.number().int().nonnegative(), confirm: z.boolean(), specification: standardSchema }).strict();
export const saveStandardBatchSchema = z.object({
  assetVersionId: z.uuid(), confirm: z.boolean(),
  views: z.array(saveStandardSchema.omit({ assetVersionId: true, confirm: true })).min(1).max(2),
}).strict();
export async function savePlacementStandard(raw: unknown, actor: CatalogUser, tenantId: string) {
  const input = saveStandardSchema.parse(raw);
  const result = await saveStandards([input], actor, false, tenantId);
  return { variantId: result.variantId, ...result.standards[0] };
}
export async function savePlacementStandardBatch(raw: unknown, actor: CatalogUser, tenantId: string) {
  const input = saveStandardBatchSchema.parse(raw);
  return saveStandards(input.views.map(view => ({ ...view, assetVersionId: input.assetVersionId, confirm: input.confirm })), actor, true, tenantId);
}
async function saveStandards(inputs: z.infer<typeof saveStandardSchema>[], actor: CatalogUser, allFaces: boolean, tenantId: string) {
  if (actor.role === 'viewer') throw new CatalogHttpError(403, '当前账号只有查看权限');
  if (new Set(inputs.map(input => input.viewId)).size !== inputs.length) throw new CatalogHttpError(400, '同一个面不能重复保存');
  const assetVersionId = inputs[0].assetVersionId;
  return catalogTransaction(async client => {
    // The client supplies the asset version id, so ownership has to be proven here rather
    // than assumed from whatever list the caller happened to render.
    const owner = await client.query('SELECT v.style_id FROM garment_asset_versions a JOIN garment_variants v ON v.id=a.variant_id JOIN garment_styles s ON s.id=v.style_id WHERE a.id=$1 AND s.tenant_id=$2', [assetVersionId, tenantId]);
    if (!owner.rowCount) throw new CatalogHttpError(404, '底图不存在');
    await client.query('SELECT id FROM garment_styles WHERE id=$1 FOR UPDATE', [owner.rows[0].style_id]);
    const result = await client.query('SELECT g.*,a.variant_id,v.current_asset_version_id FROM garment_views g JOIN garment_asset_versions a ON a.id=g.asset_version_id JOIN garment_variants v ON v.id=a.variant_id WHERE g.asset_version_id=$1 ORDER BY g.id FOR UPDATE OF g,v', [assetVersionId]);
    if (allFaces && (result.rows.length !== inputs.length || inputs.some(input => !result.rows.some(view => view.id === input.viewId)))) {
      throw new CatalogHttpError(422, '请一起提交这张底图的所有面；本次未保存');
    }
    // Validate every face before writing; the transaction also rolls back any database failure.
    for (const input of inputs) {
      const view = result.rows.find(view => view.id === input.viewId);
      if (!view) throw new CatalogHttpError(404, `视图不存在：${input.viewId}`);
      const face = view.face === 'front' ? '正面' : '背面';
      if (view.current_asset_version_id !== assetVersionId) throw new CatalogHttpError(409, '底图已经换版，请重新打开当前商品后校准；本次未保存');
      if (view.revision !== input.expectedRevision) throw new CatalogHttpError(409, `${face}已被更新，请重新打开后核对；本次未保存任何面`);
      if (input.confirm) {
        try { assertConfirmedStandard(input.specification, view.face); }
        catch (error) { throw new CatalogHttpError(422, `${face}：${error instanceof Error ? error.message : String(error)}；本次未保存任何面`); }
      }
    }
    const standards = [];
    for (const input of inputs) {
      const view = result.rows.find(view => view.id === input.viewId)!;
      const id = randomUUID(); const revision = view.revision + 1;
      await client.query("INSERT INTO placement_standard_versions(id,view_id,revision,status,specification,origin,created_by) VALUES($1,$2,$3,$4,$5,'manual',$6)", [id, view.id, revision, input.confirm ? 'confirmed' : 'draft', input.specification, actor.id]);
      await client.query('UPDATE garment_views SET revision=$2,latest_standard_id=$3,confirmed_standard_id=CASE WHEN $4 THEN $3 ELSE confirmed_standard_id END WHERE id=$1', [view.id, revision, id, input.confirm]);
      await client.query('INSERT INTO audit_events(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor.id, input.confirm ? 'standard.confirm' : 'standard.saveDraft', id, { viewId: view.id, assetVersionId, revision }]);
      standards.push({ standardId: id, revision });
    }
    return { variantId: result.rows[0].variant_id as string, standards };
  });
}
