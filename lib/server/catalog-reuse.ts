import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { alignmentSchema, assertConfirmedStandard, projectStandard, standardSchema, type CatalogAlignment, type CatalogDetail, type CatalogUser, type ReuseFace, type ReusePreview, type StyleSync, type StyleSyncFace } from '@/lib/catalog';
import { catalogReferenceType, hasTemplateLandmarks } from '@/lib/catalog-placement-suggestions';
import { SOP_STRUCTURES } from '@/lib/sop-placement';
import { CatalogHttpError } from './catalog-auth';
import { ALIGNMENT_VERSION, compareSilhouettes, garmentSilhouette } from './catalog-alignment';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { readCatalogFile } from './catalog-files';
import { catalogDetail, catalogStyle } from './catalog-repository';

const assessmentSchema = z.object({ algorithm: z.literal(ALIGNMENT_VERSION), score: z.number().min(0).max(1).nullable(), status: z.enum(['aligned', 'review']), reason: z.string() }).strict();
function assertEditor(actor: CatalogUser) { if (actor.role === 'viewer') throw new CatalogHttpError(403, '当前账号只有查看权限'); }
// Silhouettes come from the thumbnail, like the automatic sharing: it keeps the asset version's
// alpha layout at a fraction of the original's size, and the original download was most of the wait.
async function silhouetteBytes(detail: CatalogDetail) {
  return (await readCatalogFile(z.uuid().parse(detail.thumbnailUrl.split('/').at(-1)))).bytes;
}
// Colors are checked a few at a time; results keep the style's color order.
async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await run(items[i]); } }));
  return out;
}
export async function previewStandardReuse(raw: unknown, actor: CatalogUser, tenantId: string): Promise<ReusePreview> {
  assertEditor(actor);
  const input = z.object({ variantId: z.uuid() }).strict().parse(raw);
  // Source, style and every target are resolved inside the tenant, so a foreign variant id
  // simply does not exist rather than leaking a standard across accounts.
  const source = await catalogDetail(input.variantId, undefined, tenantId);
  const sourceViews = source.views.filter(v => v.latest?.status === 'confirmed' && v.latest.origin === 'manual' && v.latest.id === v.confirmedId);
  if (!sourceViews.length) throw new CatalogHttpError(422, '请先在代表颜色上保存至少一面的人工确认标准；草稿或继承标准不能作为来源');
  const style = await catalogStyle(source.styleId, tenantId);
  const reference = style.colors.find(c => c.id === style.referenceVariantId);
  if (reference && reference.id !== source.id) throw new CatalogHttpError(409, `本款代表色是「${reference.colorName}」，请在代表色上修改并应用到同款`);
  if (style.colors.length > 100) throw new CatalogHttpError(422, `款式包含 ${style.colors.length} 个颜色，超过单次检查上限 100`);
  const bytes = await silhouetteBytes(source);
  const sourceMasks = new Map<string, Awaited<ReturnType<typeof garmentSilhouette>>>();
  for (const view of sourceViews) sourceMasks.set(view.face, await garmentSilhouette(bytes, view.crop));
  const colors: ReusePreview['colors'] = await inBatches(style.colors.filter(c => c.id !== source.id), 4, async item => {
    const faces: ReuseFace[] = [];
    try {
      const target = await catalogDetail(item.id, undefined, tenantId);
      let targetBytes: Promise<Buffer> | null = null;
      for (const view of target.views) {
        const sourceView = sourceViews.find(v => v.face === view.face);
        const blocked = (reason: string): ReuseFace => ({ checkId: null, face: view.face, crop: view.crop, status: 'blocked', reason, score: null, specification: null });
        if (!sourceView) { faces.push(blocked('代表颜色的这一面尚未人工确认')); continue; }
        if (view.latest && view.latest.origin !== 'inherited') { faces.push({ ...blocked(view.latest.status === 'draft' ? '本色有单独打点的草稿；保留' : '本色单独打点；保留'), specification: view.latest.specification }); continue; }
        if (view.latest?.source?.id === sourceView.latest!.id) { faces.push({ ...blocked('已跟随代表色的最新确认版'), specification: view.latest.specification }); continue; }
        if (item.layout !== source.layout) { faces.push(blocked('正反面布局不同，请单独核对')); continue; }
        let comparison: { alignment: CatalogAlignment; score: number | null; status: 'aligned' | 'review'; reason: string } | null = null;
        if (view.latest) {
          // A follower was checked against this face of the reference before: the outline is unchanged, so keep that alignment.
          const prior = await catalogDatabase().query('SELECT p.alignment,src.view_id FROM placement_standard_versions p JOIN placement_standard_versions src ON src.id=p.source_standard_id WHERE p.id=$1', [view.latest.id]);
          if (prior.rows[0]?.view_id === sourceView.id) comparison = { alignment: alignmentSchema.parse(prior.rows[0].alignment), score: null, status: 'aligned', reason: '跟随旧版，将更新到最新确认版（沿用上次核对的对齐）' };
        }
        if (!comparison) {
          targetBytes ??= silhouetteBytes(target);
          comparison = compareSilhouettes(sourceMasks.get(view.face)!, await garmentSilhouette(await targetBytes, view.crop));
        }
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
    return { item, faces };
  });
  return { source, colors };
}

export async function applyStandardReuse(raw: unknown, actor: CatalogUser, tenantId: string) {
  assertEditor(actor);
  const input = z.object({ sourceVariantId: z.uuid(), checkIds: z.array(z.uuid()).min(1).max(200), reviewed: z.literal(true) }).strict().parse(raw);
  if (new Set(input.checkIds).size !== input.checkIds.length) throw new CatalogHttpError(400, '重复的复用检查 ID');
  return catalogTransaction(async client => {
    // The style is resolved through the tenant, so a foreign source variant is simply absent.
    const source = await client.query('SELECT v.style_id FROM garment_variants v JOIN garment_styles s ON s.id=v.style_id WHERE v.id=$1 AND s.tenant_id=$2', [input.sourceVariantId, tenantId]);
    if (!source.rowCount) throw new CatalogHttpError(404, '代表颜色不存在');
    const styleId = z.uuid().parse(source.rows[0].style_id);
    await client.query('SELECT id FROM garment_styles WHERE id=$1 FOR UPDATE', [styleId]);
    await client.query('SELECT id FROM garment_variants WHERE style_id=$1 ORDER BY id FOR UPDATE', [styleId]);
    const checks = await client.query(`SELECT c.*,g.asset_version_id,g.revision,g.latest_standard_id,g.face,a.variant_id,lp.origin AS latest_origin,v.current_asset_version_id,v.style_id,
      p.specification AS source_specification,p.origin AS source_origin,p.status AS source_status,sg.id AS source_view_id,sg.latest_standard_id AS source_latest_id,sg.confirmed_standard_id AS source_confirmed_id,
      sa.variant_id AS source_variant_id,sa.id AS source_asset_id,sv.current_asset_version_id AS source_current_asset_id
      FROM standard_reuse_checks c JOIN garment_views g ON g.id=c.target_view_id JOIN garment_asset_versions a ON a.id=g.asset_version_id JOIN garment_variants v ON v.id=a.variant_id
      LEFT JOIN placement_standard_versions lp ON lp.id=g.latest_standard_id
      JOIN placement_standard_versions p ON p.id=c.source_standard_id JOIN garment_views sg ON sg.id=p.view_id JOIN garment_asset_versions sa ON sa.id=sg.asset_version_id JOIN garment_variants sv ON sv.id=sa.variant_id
      WHERE c.id=ANY($1::uuid[]) AND c.created_by=$2 ORDER BY g.id FOR UPDATE OF c,g`, [input.checkIds, actor.id]);
    if (checks.rows.length !== input.checkIds.length) throw new CatalogHttpError(403, '复用检查不存在或不属于当前账号');
    if (checks.rows.some(c => c.source_variant_id !== input.sourceVariantId || c.style_id !== styleId || c.variant_id === input.sourceVariantId)) throw new CatalogHttpError(422, '只能复用同一款式、不同颜色的标准');
    if (checks.rows.every(c => c.applied_standard_id)) return { colors: new Set(checks.rows.map(c => c.variant_id)).size, faces: checks.rows.length, reused: true };
    const touched = new Set<string>();
    for (const c of checks.rows) {
      if (touched.has(c.target_view_id)) throw new CatalogHttpError(400, '同一个面不能重复套用');
      touched.add(c.target_view_id);
      if (c.applied_standard_id || (c.latest_standard_id && c.latest_origin !== 'inherited') || c.revision !== c.target_revision || c.current_asset_version_id !== c.asset_version_id) throw new CatalogHttpError(409, '有颜色已换图、保存草稿或修改标准，请重新检查；本次未覆盖任何内容');
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

type SyncPlan = { viewId: string; revision: number; latestId: string | null; assetVersionId: string; sourceStandardId: string; alignment: CatalogAlignment; state: 'updated' | 'applied' };
/**
 * 确认并应用到全款: the style follows its reference color's current confirmation. Followers keep
 * the alignment they were checked with and move to the new version; colors without a standard
 * whose outline lines up are applied; own standards stay; the rest are listed for review.
 * Everything is written in one transaction, or nothing if any color changed meanwhile.
 */
export async function syncStyleStandards(raw: unknown, actor: CatalogUser, tenantId: string): Promise<StyleSync> {
  assertEditor(actor);
  const input = z.object({ variantId: z.uuid() }).strict().parse(raw);
  const source = await catalogDetail(input.variantId, undefined, tenantId);
  const longSleeve = catalogReferenceType(source.namespace, source.styleCode).longSleeve;
  const sourceViews = source.views.filter(v => v.latest?.status === 'confirmed' && v.latest.origin === 'manual' && v.latest.id === v.confirmedId
    && !(SOP_STRUCTURES.includes(v.latest.specification.structureType) && hasTemplateLandmarks(v.latest.specification, v.face, longSleeve)));
  if (!sourceViews.length) throw new CatalogHttpError(422, '请先在这个颜色上确认位置（结构点需拖到衣服实际位置），再应用到全款');
  const style = await catalogStyle(source.styleId, tenantId);
  const reference = style.colors.find(c => c.id === style.referenceVariantId);
  if (reference && reference.id !== source.id) throw new CatalogHttpError(409, `本款代表色是「${reference.colorName}」，请在代表色上修改并应用到全款`);
  const bytes = await silhouetteBytes(source);
  const masks = new Map(await Promise.all(sourceViews.map(async v => [v.face, await garmentSilhouette(bytes, v.crop)] as const)));
  const plans: SyncPlan[] = [];
  const colors = await inBatches(style.colors.filter(c => c.id !== source.id), 4, async item => {
    let faces: StyleSyncFace[] = [];
    try {
      const target = await catalogDetail(item.id, undefined, tenantId);
      let targetBytes: Promise<Buffer> | null = null;
      for (const view of target.views) {
        const sourceView = sourceViews.find(v => v.face === view.face), latest = view.latest;
        const say = (state: StyleSyncFace['state'], reason: string) => faces.push({ face: view.face, state, reason });
        if (!sourceView) { say('blocked', '代表色的这一面尚未确认'); continue; }
        if (item.layout !== source.layout) { say('blocked', '正反面布局与代表色不同，请单独打点'); continue; }
        if (latest && latest.origin !== 'inherited') { say('own', latest.status === 'draft' ? '本色有单独打点的草稿，保留' : '本色单独打点，保留'); continue; }
        if (latest?.source?.id === sourceView.confirmedId && latest.id === view.confirmedId) { say('current', '已跟随最新确认版'); continue; }
        let alignment: CatalogAlignment | null = null;
        if (latest) {
          // Already checked against this face of the reference: the outline is unchanged, so the checked alignment still holds.
          const prior = await catalogDatabase().query('SELECT p.alignment,src.view_id FROM placement_standard_versions p JOIN placement_standard_versions src ON src.id=p.source_standard_id WHERE p.id=$1', [latest.id]);
          if (prior.rows[0]?.view_id === sourceView.id) alignment = alignmentSchema.parse(prior.rows[0].alignment);
        }
        if (!alignment) {
          targetBytes ??= silhouetteBytes(target);
          const comparison = compareSilhouettes(masks.get(view.face)!, await garmentSilhouette(await targetBytes, view.crop));
          if (comparison.status !== 'aligned') { say('review', comparison.reason); continue; }
          alignment = comparison.alignment;
        }
        try { assertConfirmedStandard(projectStandard(sourceView.latest!.specification, alignment), view.face); }
        catch { say('review', '套用后结构点或印制区域超出图片，请核对或单独打点'); continue; }
        const state = latest ? 'updated' : 'applied';
        plans.push({ viewId: view.id, revision: view.revision, latestId: latest?.id ?? null, assetVersionId: target.assetVersionId, sourceStandardId: sourceView.confirmedId!, alignment, state });
        say(state, state === 'updated' ? '已更新到最新确认版' : '轮廓一致，已套用');
      }
    } catch (error) { faces = [{ face: 'front', state: 'blocked', reason: `检查失败：${error instanceof Error ? error.message : String(error)}` }]; }
    return { variantId: item.id, colorName: item.colorName, faces };
  });
  await catalogTransaction(async client => {
    await client.query('SELECT id FROM garment_styles WHERE id=$1 FOR UPDATE', [style.id]);
    await client.query('SELECT id FROM garment_variants WHERE style_id=$1 ORDER BY id FOR UPDATE', [style.id]);
    const current = await client.query('SELECT s.reference_variant_id,v.current_asset_version_id FROM garment_styles s JOIN garment_variants v ON v.id=$2 WHERE s.id=$1', [style.id, source.id]);
    if (current.rows[0].reference_variant_id && current.rows[0].reference_variant_id !== source.id) throw new CatalogHttpError(409, '本款代表色刚被更换，请重新打开后再应用；本次未改动任何颜色');
    const sourceNow = await client.query('SELECT id,latest_standard_id,confirmed_standard_id FROM garment_views WHERE id=ANY($1::uuid[]) FOR UPDATE', [sourceViews.map(v => v.id)]);
    if (current.rows[0].current_asset_version_id !== source.assetVersionId || sourceNow.rows.some(r => { const v = sourceViews.find(x => x.id === r.id)!; return r.confirmed_standard_id !== v.confirmedId || r.latest_standard_id !== v.confirmedId; })) throw new CatalogHttpError(409, '代表色的图片或标准刚被更新，请重新应用到全款；本次未改动任何颜色');
    const targets = plans.length ? (await client.query('SELECT g.id,g.revision,g.latest_standard_id,g.asset_version_id,v.current_asset_version_id FROM garment_views g JOIN garment_asset_versions a ON a.id=g.asset_version_id JOIN garment_variants v ON v.id=a.variant_id WHERE g.id=ANY($1::uuid[]) FOR UPDATE OF g', [plans.map(p => p.viewId)])).rows : [];
    for (const plan of plans) {
      const row = targets.find(r => r.id === plan.viewId);
      if (!row || row.revision !== plan.revision || row.latest_standard_id !== plan.latestId || row.current_asset_version_id !== plan.assetVersionId) throw new CatalogHttpError(409, '有颜色刚被修改或换图，请重新应用到全款；本次未改动任何颜色');
    }
    for (const plan of plans) {
      const id = randomUUID();
      await client.query("INSERT INTO placement_standard_versions(id,view_id,revision,status,specification,source_standard_id,alignment,origin,created_by) VALUES($1,$2,$3,'confirmed',NULL,$4,$5,'inherited',$6)", [id, plan.viewId, plan.revision + 1, plan.sourceStandardId, plan.alignment, actor.id]);
      await client.query('UPDATE garment_views SET revision=revision+1,latest_standard_id=$2,confirmed_standard_id=$2 WHERE id=$1', [plan.viewId, id]);
      await client.query('INSERT INTO audit_events(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor.id, 'standard.sync', id, { sourceStandardId: plan.sourceStandardId, previousStandardId: plan.latestId, state: plan.state, alignment: plan.alignment }]);
    }
    await client.query('UPDATE garment_styles SET reference_variant_id=$2 WHERE id=$1', [style.id, source.id]);
  });
  return { sourceVariantId: source.id, sourceColor: source.colorName, colors };
}
