import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { alignmentSchema, assertConfirmedStandard, projectStandard, standardSchema, type CatalogUser, type ReuseFace, type ReusePreview } from '@/lib/catalog';
import { CatalogHttpError } from './catalog-auth';
import { ALIGNMENT_VERSION, compareSilhouettes, garmentSilhouette } from './catalog-alignment';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { readCatalogFile } from './catalog-files';
import { catalogDetail, catalogStyle } from './catalog-repository';

const assessmentSchema = z.object({ algorithm: z.literal(ALIGNMENT_VERSION), score: z.number().min(0).max(1).nullable(), status: z.enum(['aligned', 'review']), reason: z.string() }).strict();
function assertEditor(actor: CatalogUser) { if (actor.role === 'viewer') throw new CatalogHttpError(403, '当前账号只有查看权限'); }
async function assetBytes(assetVersionId: string) {
  const result = await catalogDatabase().query('SELECT file_id FROM garment_asset_versions WHERE id=$1', [assetVersionId]);
  if (!result.rowCount) throw new CatalogHttpError(404, `底图版本不存在：${assetVersionId}`);
  return (await readCatalogFile(z.uuid().parse(result.rows[0].file_id))).bytes;
}
export async function previewStandardReuse(raw: unknown, actor: CatalogUser): Promise<ReusePreview> {
  assertEditor(actor);
  const input = z.object({ variantId: z.uuid() }).strict().parse(raw);
  const source = await catalogDetail(input.variantId);
  const sourceViews = source.views.filter(v => v.latest?.status === 'confirmed' && v.latest.origin === 'manual' && v.latest.id === v.confirmedId);
  if (!sourceViews.length) throw new CatalogHttpError(422, '请先在代表颜色上保存至少一面的人工确认标准；草稿或继承标准不能作为来源');
  const style = await catalogStyle(source.styleId);
  if (style.colors.length > 100) throw new CatalogHttpError(422, `款式包含 ${style.colors.length} 个颜色，超过单次检查上限 100`);
  const bytes = await assetBytes(source.assetVersionId);
  const sourceMasks = new Map<string, Awaited<ReturnType<typeof garmentSilhouette>>>();
  for (const view of sourceViews) sourceMasks.set(view.face, await garmentSilhouette(bytes, view.crop));
  const colors: ReusePreview['colors'] = [];
  for (const item of style.colors.filter(c => c.id !== source.id)) {
    const faces: ReuseFace[] = [];
    try {
      const target = await catalogDetail(item.id);
      const targetBytes = await assetBytes(target.assetVersionId);
      for (const view of target.views) {
        const sourceView = sourceViews.find(v => v.face === view.face);
        const blocked = (reason: string): ReuseFace => ({ checkId: null, face: view.face, crop: view.crop, status: 'blocked', reason, score: null, specification: null });
        if (!sourceView) { faces.push(blocked('代表颜色的这一面尚未人工确认')); continue; }
        if (view.latest) { faces.push(blocked(view.latest.origin === 'inherited' ? '已有复用标准；保留当前版本' : '已有单独校准或草稿；保留当前内容')); continue; }
        if (item.layout !== source.layout) { faces.push(blocked('正反面布局不同，请单独核对')); continue; }
        const comparison = compareSilhouettes(sourceMasks.get(view.face)!, await garmentSilhouette(targetBytes, view.crop));
        let specification;
        try { specification = projectStandard(sourceView.latest!.specification, comparison.alignment); assertConfirmedStandard(specification, view.face); }
        catch { faces.push(blocked('对齐后的结构点或印制区域超出图片范围，请单独校准')); continue; }
        const assessment = assessmentSchema.parse({ algorithm: ALIGNMENT_VERSION, score: comparison.score, status: comparison.status, reason: comparison.reason });
        const checkId = randomUUID();
        await catalogDatabase().query('INSERT INTO standard_reuse_checks(id,source_standard_id,target_view_id,target_revision,alignment,assessment,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [checkId, sourceView.latest!.id, view.id, view.revision, comparison.alignment, assessment, actor.id]);
        faces.push({ checkId, face: view.face, crop: view.crop, status: comparison.status, reason: comparison.reason, score: comparison.score, specification });
      }
    } catch (error) {
      faces.length = 0;
      faces.push({ checkId: null, face: 'front', crop: { x: 0, y: 0, width: item.layout === 'front_back' ? .5 : 1, height: 1 }, status: 'blocked', reason: `检查失败：${error instanceof Error ? error.message : String(error)}`, score: null, specification: null });
    }
    colors.push({ item, faces });
  }
  return { source, colors };
}

export async function applyStandardReuse(raw: unknown, actor: CatalogUser) {
  assertEditor(actor);
  const input = z.object({ sourceVariantId: z.uuid(), checkIds: z.array(z.uuid()).min(1).max(200), reviewed: z.literal(true) }).strict().parse(raw);
  if (new Set(input.checkIds).size !== input.checkIds.length) throw new CatalogHttpError(400, '重复的复用检查 ID');
  return catalogTransaction(async client => {
    const source = await client.query('SELECT style_id FROM garment_variants WHERE id=$1', [input.sourceVariantId]);
    if (!source.rowCount) throw new CatalogHttpError(404, '代表颜色不存在');
    const styleId = z.uuid().parse(source.rows[0].style_id);
    await client.query('SELECT id FROM garment_styles WHERE id=$1 FOR UPDATE', [styleId]);
    await client.query('SELECT id FROM garment_variants WHERE style_id=$1 ORDER BY id FOR UPDATE', [styleId]);
    const checks = await client.query(`SELECT c.*,g.asset_version_id,g.revision,g.latest_standard_id,g.face,a.variant_id,v.current_asset_version_id,v.style_id,
      p.specification AS source_specification,p.origin AS source_origin,p.status AS source_status,sg.id AS source_view_id,sg.latest_standard_id AS source_latest_id,sg.confirmed_standard_id AS source_confirmed_id,
      sa.variant_id AS source_variant_id,sa.id AS source_asset_id,sv.current_asset_version_id AS source_current_asset_id
      FROM standard_reuse_checks c JOIN garment_views g ON g.id=c.target_view_id JOIN garment_asset_versions a ON a.id=g.asset_version_id JOIN garment_variants v ON v.id=a.variant_id
      JOIN placement_standard_versions p ON p.id=c.source_standard_id JOIN garment_views sg ON sg.id=p.view_id JOIN garment_asset_versions sa ON sa.id=sg.asset_version_id JOIN garment_variants sv ON sv.id=sa.variant_id
      WHERE c.id=ANY($1::uuid[]) AND c.created_by=$2 ORDER BY g.id FOR UPDATE OF c,g`, [input.checkIds, actor.id]);
    if (checks.rows.length !== input.checkIds.length) throw new CatalogHttpError(403, '复用检查不存在或不属于当前账号');
    if (checks.rows.some(c => c.source_variant_id !== input.sourceVariantId || c.style_id !== styleId || c.variant_id === input.sourceVariantId)) throw new CatalogHttpError(422, '只能复用同一款式、不同颜色的标准');
    if (checks.rows.every(c => c.applied_standard_id)) return { colors: new Set(checks.rows.map(c => c.variant_id)).size, faces: checks.rows.length, reused: true };
    const touched = new Set<string>();
    for (const c of checks.rows) {
      if (touched.has(c.target_view_id)) throw new CatalogHttpError(400, '同一个面不能重复套用');
      touched.add(c.target_view_id);
      if (c.applied_standard_id || c.latest_standard_id || c.revision !== c.target_revision || c.current_asset_version_id !== c.asset_version_id) throw new CatalogHttpError(409, '有颜色已换图、保存草稿或修改标准，请重新检查；本次未覆盖任何内容');
      if (c.source_origin !== 'manual' || c.source_status !== 'confirmed' || c.source_latest_id !== c.source_standard_id || c.source_confirmed_id !== c.source_standard_id || c.source_current_asset_id !== c.source_asset_id) throw new CatalogHttpError(409, '代表颜色的图片或标准已更新，请重新检查');
      if (Date.now() - z.date().parse(c.created_at).getTime() > 24 * 60 * 60 * 1000) throw new CatalogHttpError(409, '复用预览已超过 24 小时，请重新检查');
      assessmentSchema.parse(c.assessment);
      const alignment = alignmentSchema.parse(c.alignment);
      assertConfirmedStandard(projectStandard(standardSchema.parse(c.source_specification), alignment), z.enum(['front', 'back']).parse(c.face));
    }
    for (const c of checks.rows) {
      const id = randomUUID();
      await client.query("INSERT INTO placement_standard_versions(id,view_id,revision,status,specification,source_standard_id,alignment,origin,created_by) VALUES($1,$2,$3,'confirmed',NULL,$4,$5,'inherited',$6)", [id, c.target_view_id, c.revision + 1, c.source_standard_id, c.alignment, actor.id]);
      await client.query('UPDATE garment_views SET revision=revision+1,latest_standard_id=$2,confirmed_standard_id=$2 WHERE id=$1', [c.target_view_id, id]);
      await client.query('UPDATE standard_reuse_checks SET applied_standard_id=$2 WHERE id=$1', [c.id, id]);
      await client.query('INSERT INTO audit_events(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor.id, 'standard.reuse', id, { checkId: c.id, sourceStandardId: c.source_standard_id, targetAssetVersionId: c.asset_version_id, assessment: c.assessment, reviewed: true }]);
    }
    await client.query('UPDATE garment_styles SET reference_variant_id=$2 WHERE id=$1', [styleId, input.sourceVariantId]);
    return { colors: new Set(checks.rows.map(c => c.variant_id)).size, faces: checks.rows.length, reused: false };
  });
}
