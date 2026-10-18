/**
 * 「用这份素材再出一套」: a product made again on other masters from the same material, without
 * uploading it again or paying for its analysis again (10-18: the user wanted 版式一到五 and other
 * selling points from one upload). Each copy is a product of its own, at 「定方案」: the uploaded
 * images point at the same files (no storage counted twice), the analysis is copied, and each
 * colour's white image and the cast are carried over with their jobs, so a plan with the same colour
 * images and model uses them instead of drawing them again (draft.ts reusedSlots).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Reuse } from '../listing/draft';
import type { Layout } from '../listing/templates';
import { catalogTransaction } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { registerFileRef } from './file-authorization';
import type { Materials } from './listing-jobs';
import { resolveLayout } from './listing-layouts';
import type { StoredPlan } from './listing-store';

/** The images a copy carries over: every colour's white image and the cast (both halves when drawn from the material's photos). */
const CARRIED = /^(product:.+|cast(:.+)?)$/;
export const MAX_COPIES = 5;

export async function copyProject(tenant: string, user: string, sourceId: string, input: unknown) {
  z.uuid().parse(sourceId);
  const { layouts } = z.object({ layouts: z.array(z.string().min(1).max(64)).min(1, '至少选一个版式').max(MAX_COPIES, `一次最多再出 ${MAX_COPIES} 套`) }).parse(input);
  const picked: Layout[] = [];
  for (const id of layouts) {
    const layout = await resolveLayout(tenant, id, { forNewProject: true });
    if (!layout) throw new CatalogHttpError(400, '没有这个版式');
    picked.push(layout);
  }
  return catalogTransaction(async c => {
    await c.query('SELECT id FROM tenants WHERE id=$1 AND NOT disabled FOR UPDATE', [tenant]);
    const p = (await c.query(`SELECT name,counts,status,materials,plan,sources_cleared_at FROM listing_projects
      WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL AND kind='product' FOR UPDATE`, [sourceId, tenant])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (!p.materials || !['materials', 'writing', 'generating', 'square', 'done'].includes(p.status)) throw new CatalogHttpError(409, '素材整理好之后才能再出一套');
    if (p.sources_cleared_at) throw new CatalogHttpError(409, '这款的原始素材已经清理，不能再出一套，请重新上传');
    const m = p.materials as Materials, stored = p.plan as StoredPlan | null;
    const sources = (await c.query(`SELECT id,file_id,name,rel_path,width,height FROM listing_assets WHERE project_id=$1 AND kind='source'`, [sourceId])).rows as
      { id: string; file_id: string; name: string; rel_path: string; width: number; height: number }[];
    // Each carried slot's current image and the job that made it (its input lets 「重新生成」 work on the copy).
    const carried = (await c.query(`SELECT DISTINCT ON (a.slot) a.slot,a.file_id,a.kind,a.name,a.width,a.height,j.step,j.input,j.depends
      FROM listing_assets a JOIN listing_jobs j ON j.id=a.job_id
      WHERE a.project_id=$1 AND a.slot IS NOT NULL AND NOT a.candidate AND j.status='succeeded'
      ORDER BY a.slot, GREATEST(a.created_at, COALESCE(a.chosen_at, a.created_at)) DESC`, [sourceId])).rows
      .filter(r => CARRIED.test(r.slot)) as { slot: string; file_id: string; kind: string; name: string; width: number; height: number; step: string; input: unknown; depends: string[] }[];
    const reuse: Reuse | undefined = stored && carried.length
      ? { colors: Object.fromEntries(stored.colors.map(x => [x.sku, x.name])), model: stored.draft.model, slots: carried.map(r => r.slot) } : undefined;
    // Copies of copies count from the first product: their names and their seeds (draft.seed) follow on.
    const root = m.from ?? sourceId, base = m.baseName ?? p.name;
    const before = Number((await c.query(`SELECT count(*)::int n FROM listing_projects WHERE tenant_id=$1 AND materials->>'from'=$2`, [tenant, root])).rows[0].n);
    const made: { id: string; name: string; layout: string }[] = [];
    for (const [k, layout] of picked.entries()) {
      const id = randomUUID(), name = `${base} · ${layout.name.split(' · ')[0]}`.slice(0, 120), assetOf = new Map<string, string>();
      for (const s of sources) assetOf.set(s.id, randomUUID());
      const materials: Materials = {
        ...m, from: root, baseName: base, variant: before + k + 1, ...(reuse ? { reuse } : {}),
        look: { ...(m.look ?? { why: '' }), master: layout.id },
        images: m.images.filter(i => assetOf.has(i.assetId)).map(i => ({ label: i.label, assetId: assetOf.get(i.assetId)! })),
      };
      delete materials.draft;
      await c.query(`INSERT INTO listing_projects(id,tenant_id,created_by,name,layout,counts,status,materials) VALUES($1,$2,$3,$4,$5,$6,'materials',$7)`,
        [id, tenant, user, name, layout.id, p.counts, materials]);
      for (const s of sources) {
        await c.query(`INSERT INTO listing_assets(id,tenant_id,project_id,file_id,kind,name,rel_path,width,height) VALUES($1,$2,$3,$4,'source',$5,$6,$7,$8)`,
          [assetOf.get(s.id), tenant, id, s.file_id, s.name, s.rel_path, s.width, s.height]);
        await registerFileRef(s.file_id, tenant, 'listing-images', s.name, c);
      }
      for (const r of carried) {
        const job = randomUUID(), asset = randomUUID();
        await c.query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step,status,slot,input,depends,result_asset) VALUES($1,$2,$3,$4,$5,'succeeded',$6,$7,$8,$9)`,
          [job, tenant, id, user, r.step, r.slot, r.input, r.depends, asset]);
        await c.query(`INSERT INTO listing_assets(id,tenant_id,project_id,file_id,kind,name,rel_path,width,height,slot,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [asset, tenant, id, r.file_id, r.kind, r.name, `${r.slot}#${job}`, r.width, r.height, r.slot, job]);
        await registerFileRef(r.file_id, tenant, 'listing-images', r.name, c);
      }
      made.push({ id, name, layout: layout.id });
    }
    return { projects: made };
  });
}
