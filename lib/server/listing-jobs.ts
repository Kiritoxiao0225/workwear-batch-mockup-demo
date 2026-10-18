/**
 * 电商主图 background work. Same lifecycle as the garment AI queue: credits are held before a job
 * exists, a provider call is recorded before it is sent, and a sent call is never repeated.
 */
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile } from './catalog-files';
import { currentPrices, holdCredits, microToCents, priceOf, releaseHold, settleHold } from './credits';
import { directKeys, draftImages, pickProblems, reusedSlots, usedSlots, type Reuse } from '../listing/draft';
import { draftSchema, type SubmittedDraft } from '../listing/draft-schema';
import { skuPhotos } from '../listing/sku-card';
import { skuPair } from '../listing/templates';
import { claimLayout, executeLayout, renewLayoutLease, resolveLayout } from './listing-layouts';
import { chooseMaterials, coloursRequest, parseColours, parseRead, parseSorted, readRequest, recolored, settleCopies, sortRequest, worthReading, type Organized, type SortedImage } from './listing-organize';
import { buildPlan, writeRequest } from './listing-write';
import { colourSources, planViews, type PlanSource, type PlanView } from './listing-plan-views';
import { assertListingProviderConfigured, callPlanModel, LISTING_PLAN_MODEL, listingPlanProvider, listingWorkerConcurrency, type PlanCall } from './listing-provider';
import { addSourceImage, clearOldSources, sourceImages } from './listing-store';
import { sweepExpiredReservations } from './quota';
import sharp from 'sharp';
import { executeImage, failBlocked, finishRun, holdRun, insertJobs, planJobs, runHold, type JobInput, type Upscale } from './listing-generation';
import type { Tenant } from './tenant-scope';

const holdId = (jobId: string) => 'listing:' + jobId;
const db = () => catalogDatabase();

/** Credits for one image, one multi-colour image and learning a layout, for the page's buttons. */
export async function imagePrices() {
  const prices = await currentPrices();
  return { imageCredits: microToCents(priceOf(prices, 'listing_image').userMicroCents), multiCredits: microToCents(priceOf(prices, 'listing_image_multi').userMicroCents),
    layoutCredits: microToCents(priceOf(prices, 'listing_layout').userMicroCents) };
}

/** Credits the planning step will hold, for the page to show before the user starts. */
export async function planPrice() {
  return microToCents(priceOf(await currentPrices(), 'listing_plan').userMicroCents);
}

/** Uploads are done: hold the planning price and queue the analysis. */
export async function requestPlan(tenant: Tenant, user: string, projectId: string) {
  assertListingProviderConfigured();
  const prices = await currentPrices();
  const price = priceOf(prices, 'listing_plan');
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (p.status === 'planning') return { status: 'planning' };
    if (!['uploading', 'failed'].includes(p.status)) throw new CatalogHttpError(409, '这个商品已经分析过了');
    const images = Number((await c.query('SELECT count(*) n FROM listing_assets WHERE project_id=$1', [projectId])).rows[0].n);
    if (!images) throw new CatalogHttpError(400, '还没有上传图片');
    if (!(await c.query("SELECT 1 FROM listing_workers WHERE heartbeat_at>now()-interval '45 seconds' LIMIT 1")).rowCount) {
      throw new CatalogHttpError(503, '电商主图后台未连接，未冻结积分，请稍后再试');
    }
    const id = randomUUID();
    await holdCredits(c, { id: holdId(id), tenantId: tenant.id, kind: 'analysis', jobRef: 'listing:plan:' + projectId,
      billingMode: tenant.billingMode, amountCents: microToCents(price.userMicroCents), snapshot: prices });
    await c.query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step) VALUES($1,$2,$3,$4,'plan')`, [id, tenant.id, projectId, user]);
    await c.query(`UPDATE listing_projects SET status='planning', error=NULL, updated_at=now() WHERE id=$1`, [projectId]);
    return { status: 'planning' };
  });
}

type JobRow = { id: string; tenant_id: string; project_id: string; step: string };
type Provider = (request: object, hooks: { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> }) => Promise<PlanCall>;

/** Every source image of the product, read once; the planning call sees them packed (see listing-plan-views). */
async function planSources(projectId: string): Promise<{ sources: PlanSource[]; map: { label: string; assetId: string }[] }> {
  const rows = await sourceImages(projectId);
  const sources = await Promise.all(rows.map(async row => {
    const folder = posix.dirname(row.rel_path);
    return { id: row.label, name: row.name, folder: folder === '.' ? '' : folder, shape: row.shape, width: row.width, height: row.height, bytes: (await readCatalogFile(row.file_id)).bytes };
  }));
  return { sources, map: rows.map(row => ({ label: row.label, assetId: row.id })) };
}

/** Images sorted per call: short answers that come back well within the time a connection stays open. */
export const SORT_BATCH = 40;
/** The views in folder order, cut into batches of about SORT_BATCH images. */
export function sortBatches(views: PlanView[], max = SORT_BATCH): PlanView[][] {
  const batches: PlanView[][] = [];
  for (const v of views) {
    const last = batches.at(-1);
    if (last && last.reduce((n, x) => n + x.ids.length, 0) + v.ids.length <= max) last.push(v); else batches.push([v]);
  }
  return batches;
}
/** What a part of the analysis was asked, so a kept answer is used again only for the same question. */
const partKey = (request: { model: string; messages: { content: unknown }[] }) =>
  createHash('sha256').update(JSON.stringify([request.model, request.messages[0].content, request.messages[1].content])).digest('hex').slice(0, 40);
const idsOf = (views: PlanView[]) => views.flatMap(v => v.ids);

/**
 * Step one, in parts (10-13): the images are sorted a batch at a time (three at once), then the
 * whole product is read from the images worth reading. Every part is kept as it comes back
 * (listing_plan_parts), so after a cut connection 「继续整理」 asks only for what is missing, and
 * the product is charged once, when the whole analysis is done.
 */
export async function executePlan(job: JobRow, provider: Provider = (request, hooks) => callPlanModel(request, hooks)) {
  const model = LISTING_PLAN_MODEL();
  const attempts: { id: string; status: 'succeeded' | 'failed' | 'unknown' }[] = [];
  const fail = async (message: string, status: 'failed' | 'unknown') => {
    await db().query(`UPDATE listing_jobs SET status=$2,error=$3,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, status, message.slice(0, 500)]);
    await db().query(`UPDATE listing_projects SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='planning'`, [job.project_id, message.slice(0, 500)]);
  };
  const kept = new Map<string, unknown>();
  let lastModel = '';
  /** One part: the kept answer when there is one, else a call whose answer is kept once it reads. */
  const ask = async <T,>(request: { model: string; messages: { content: unknown }[] }, read: (content: string) => T): Promise<T> => {
    const key = partKey(request);
    if (kept.has(key)) return kept.get(key) as T;
    const attemptId = randomUUID();
    let submitted = false;
    try {
      const call = await provider(request, {
        beforeSubmit: async () => {
          await db().query(`INSERT INTO listing_attempts(id,job_id,provider,model,status) VALUES($1,$2,$3,$4,'submitted')`, [attemptId, job.id, listingPlanProvider(), model]);
          submitted = true;
        },
        receipt: async id => { await db().query('UPDATE listing_attempts SET provider_request_id=$2 WHERE id=$1', [attemptId, id]); },
      });
      await db().query(`UPDATE listing_attempts SET status='succeeded',receipt=$2,finished_at=now() WHERE id=$1`, [attemptId, { model: call.model, usage: call.usage, durationMs: call.durationMs }]);
      attempts.push({ id: attemptId, status: 'succeeded' });
      lastModel = call.model || lastModel;
      const result = read(call.content);
      await db().query('INSERT INTO listing_plan_parts(project_id,key,result) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING', [job.project_id, key, JSON.stringify(result)]);
      kept.set(key, result);
      return result;
    } catch (error) {
      if (submitted && !attempts.some(a => a.id === attemptId)) {
        // Refused outright (4xx): nothing was produced or charged. Otherwise it may have been.
        const status = (error as { definite?: boolean }).definite ? 'failed' : 'unknown';
        await db().query(`UPDATE listing_attempts SET status=$2,finished_at=now() WHERE id=$1`, [attemptId, status]);
        attempts.push({ id: attemptId, status });
      }
      throw error;
    }
  };
  try {
    const hold = (await db().query('SELECT state FROM credit_holds WHERE id=$1 AND tenant_id=$2', [holdId(job.id), job.tenant_id])).rows[0];
    if (hold?.state !== 'held') throw new Error('缺少有效积分冻结');
    for (const r of (await db().query('SELECT key,result FROM listing_plan_parts WHERE project_id=$1', [job.project_id])).rows) kept.set(r.key, r.result);
    const project = (await db().query('SELECT name FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
    const { sources, map } = await planSources(job.project_id);
    const { views, duplicates } = await planViews(sources);
    const batches = sortBatches(views);
    // The colour list first, so every batch names a colour the way the material does (10-14).
    let palette: string[];
    try {
      const told = await planViews(colourSources(sources));
      palette = (await ask(coloursRequest({ views: told.views, paths: sources.map(s => `${s.id}：${s.folder ? s.folder + '/' : ''}${s.name}`), model, product: project.name }), parseColours)).map(c => c.name);
    } catch (error) { throw Object.assign(error as Error, { done: 0, total: batches.length + 2 }); }
    // Three batches at a time; every batch is tried, so one cut connection loses only its own.
    const sorted: SortedImage[][] = new Array(batches.length);
    let next = 0, firstError: unknown = null;
    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
      while (next < batches.length) {
        const k = next++, b = batches[k];
        try { sorted[k] = await ask(sortRequest({ views: b, model, product: project.name, colors: palette }), content => parseSorted(content, idsOf(b))); } catch (error) { firstError ??= error; }
      }
    }));
    if (firstError) throw Object.assign(firstError as Error, { done: sorted.filter(Boolean).length + 1, total: batches.length + 2 });
    const images = recolored(settleCopies(sorted.flat()), palette), readable = new Set(worthReading(images).map(i => i.id));
    const toRead = sources.filter(s => !duplicates.has(s.id) && readable.has(s.id));
    const readViews = (await planViews(toRead.length ? toRead : sources.filter(s => !duplicates.has(s.id)))).views;
    let organized: Organized;
    try { organized = await ask(readRequest({ views: readViews, model, product: project.name, images, colors: palette }), content => parseRead(content, images)); } catch (error) {
      throw Object.assign(error as Error, { done: batches.length + 1, total: batches.length + 2 });
    }
    const certain = attempts.find(a => a.status === 'succeeded');
    if (certain) await settleHold(holdId(job.id), job.tenant_id, [{ action: 'listing_plan', billable: true, certain: true, attemptId: certain.id }]);
    else await releaseHold(holdId(job.id), job.tenant_id, '整理全部用了之前存下的结果').catch(() => {});
    const { look, ...rest } = organized;
    const keptSources = sources.filter(s => !duplicates.has(s.id));
    const materials: Materials = { category: organized.category, categoryWhy: organized.categoryWhy, checks: organized.checks, titles: organized.titles, themes: organized.themes, look,
      sorted: rest, chosen: chooseMaterials(organized, keptSources), duplicates: [...duplicates], model: lastModel || model, images: map };
    await db().query(`UPDATE listing_projects SET status='materials',materials=$2,plan=NULL,error=NULL,updated_at=now() WHERE id=$1`, [job.project_id, materials]);
    await db().query(`UPDATE listing_jobs SET status='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id]);
  } catch (error) {
    const raw = error instanceof Error ? error.message : '分析失败', where = error as { done?: number; total?: number; definite?: boolean };
    const progress = kept.size;
    if (progress > 0) {
      // Part of the analysis is kept: nothing is charged now; 「继续整理」 does the rest and is charged once, when done.
      await releaseHold(holdId(job.id), job.tenant_id, '整理到一半中断，已存进度，继续整理做完时再计费').catch(() => {});
      await fail(`整理到一半中断了（${raw}）：已完成 ${where.done ?? progress}/${where.total ?? '?'} 段，进度已保存。点「继续整理」只做剩下的，这次不扣费`, 'failed');
    } else if (attempts.some(a => a.status === 'unknown')) {
      // A request that reached the provider may have been charged; it is never sent again by itself.
      await settleHold(holdId(job.id), job.tenant_id, attempts.map(a => ({ action: 'listing_plan' as const, billable: a.status !== 'failed', certain: false, attemptId: a.id }))).catch(() => {});
      await fail(`${raw}。可能已产生费用，由管理员核对`, 'unknown');
    } else if (attempts.some(a => a.status === 'succeeded')) {
      // An answer came back but could not be read: the analysis is charged only when it is done (10-14).
      await releaseHold(holdId(job.id), job.tenant_id, '整理结果不完整').catch(() => {});
      await fail(`${raw}（模型回的整理结果不完整）。未扣费，可以重新分析`, 'failed');
    } else if (attempts.length) {
      await releaseHold(holdId(job.id), job.tenant_id, '分析接口拒绝').catch(() => {});
      await fail(`${raw}（接口拒绝了这次请求）。未扣费，可以重新分析`, 'failed');
    } else {
      await releaseHold(holdId(job.id), job.tenant_id, '未提交模型').catch(() => {});
      await fail(`${raw}。未扣费，可以重新分析`, 'failed');
    }
  }
}

/**
 * The sorted material of a product and the program's picks; `draft`: the plan the user started generating from.
 * A copy (「再出一套」, listing-copy): `from` the first product, its `baseName`, the copy's `variant` (its plan's seed) and what it `reuse`s.
 */
export type Materials = {
  category: string; categoryWhy: string; checks: Organized['checks']; titles: Organized['titles']; themes?: Organized['themes']; look?: Organized['look'];
  sorted: Omit<Organized, 'look'>; chosen: ReturnType<typeof chooseMaterials>; duplicates: [string, string][]; model: string; images: { label: string; assetId: string }[]; draft?: SubmittedDraft & { runId: string };
  from?: string; baseName?: string; variant?: number; reuse?: Reuse;
};

/**
 * The user started generating from the plan page: check the plan against the material, hold the
 * whole set's credits and queue the writing (free: part of the analysis). Generation follows it.
 */
export async function submitDraft(tenant: Tenant, user: string, projectId: string, input: unknown) {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) {
    // Said the way the page says it: which image, which words.
    const FIELD: Record<string, string> = { title: '大标题', sub: '小字', tags: '标签', cells: '格子', colors: '颜色', name: '颜色名', pick: '衣服图', text: '卖点' };
    const where = (path: PropertyKey[]) => path[0] === 'slots' ? `第 ${Number(path[1]) + 1} 张图的${FIELD[String(path[2])] ?? '内容'}` : path[0] === 'long' ? `长图的${FIELD[String(path[1])] ?? '内容'}` : path[0] === 'colors' ? `第 ${Number(path[1]) + 1} 个颜色的${FIELD[String(path[2])] ?? '内容'}` : path[0] === 'points' ? '卖点' : '方案';
    const issue = parsed.error.issues[0];
    throw new CatalogHttpError(400, issue.code === 'too_big' ? (issue.origin === 'array' ? `${where(issue.path)}最多 ${issue.maximum} 个，请删掉一些` : `${where(issue.path)}太长了，请删短一点`) : `${where(issue.path)}不对：${issue.message}`);
  }
  const draft = parsed.data as unknown as SubmittedDraft;
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status,layout,materials FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    // The product's own layout still works after the team deleted it; any other must still exist.
    for (const id of new Set([draft.layout, ...draft.extra.map(e => e.layout).filter(Boolean)])) {
      if (!(await resolveLayout(tenant.id, id, { forNewProject: id !== p.layout }))) throw new CatalogHttpError(400, '没有这个版式');
    }
    const layout = (await resolveLayout(tenant.id, draft.layout))!;
    if (['writing', 'generating'].includes(p.status)) return { status: p.status };
    if (p.status !== 'materials' || !p.materials) throw new CatalogHttpError(409, '素材还没整理好，或者已经开始出图了');
    const m = p.materials as Materials, labels = new Set(m.images.map(i => i.label)), names = draft.colors.map(x => x.name);
    const unknown = [...draft.colors.map(x => x.pick), ...draft.parts.map(x => x.pick)].filter((x): x is string => !!x && !labels.has(x));
    if (unknown.length) throw new CatalogHttpError(400, `图片不存在：${unknown.join('、')}`);
    if (new Set(names).size !== names.length) throw new CatalogHttpError(400, '有两个颜色名一样');
    const problem = pickProblems(draft.colors, m.sorted.images)[0];
    if (problem) throw new CatalogHttpError(400, problem);
    if (!names.includes(draft.main)) throw new CatalogHttpError(400, '主推色不在颜色里');
    if (!draft.parts.find(x => x.part === '正面全身')?.pick) throw new CatalogHttpError(400, '缺正面全身图，补上后才能出图');
    const ids = new Set(draft.points.map(x => x.id));
    for (const [k, i] of usedSlots(draft, draft.counts.square).entries()) {
      const s = draft.slots[i];
      if (!s.title) throw new CatalogHttpError(400, `第 ${k + 1} 张还没有大标题`);
      if (s.colors.some(x => !names.includes(x))) throw new CatalogHttpError(400, `第 ${k + 1} 张的颜色不对`);
      if (s.cells.some(x => !ids.has(x.point))) throw new CatalogHttpError(400, `第 ${k + 1} 张有格子的卖点不存在`);
    }
    // With square images the long image is the cover laid out again, in the cover's words.
    if (draft.counts.long && !draft.counts.square && !draft.long.title) throw new CatalogHttpError(400, '长图还没有字');
    if (draft.extra.some(e => !names.includes(e.color) || e.color === draft.main) || new Set(draft.extra.map(e => e.color)).size !== draft.extra.length) throw new CatalogHttpError(400, '加的那套首图颜色不对');
    const direct = new Set(directKeys(draft.colors, m.sorted.images));
    // Round one is held now; 「出竖版」 holds round two.
    const photos = new Set(Object.keys(skuPhotos(draft, m.sorted.images, skuPair(layout))));
    const runId = await holdRun(c, tenant, projectId, draftImages(draft, layout, direct, photos, reusedSlots(draft, m.reuse)).filter(i => i.round === 1), prices);
    await c.query(`UPDATE listing_projects SET status='writing',layout=$2,counts=$3,materials=materials || $4::jsonb,error=NULL,updated_at=now() WHERE id=$1`,
      [projectId, draft.layout, draft.counts, { draft: { ...draft, runId } }]);
    await c.query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step) VALUES($1,$2,$3,$4,'write')`, [randomUUID(), tenant.id, projectId, user]);
    return { status: 'writing' };
  });
}

/**
 * An image added on the plan page (a colour or a detail the folder lacked). It gets its own label
 * (X1, X2, …) so the labels the model saw do not move; it is extracted by the model like a colour
 * image, never used as the product image directly.
 */
export async function addExtraImage(tenant: string, projectId: string, bytes: Buffer, name: string) {
  const added = await addSourceImage(tenant, projectId, bytes, name, `补传/${name}`, ['materials']);
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT materials FROM listing_projects WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [projectId, tenant])).rows[0];
    const m = p.materials as Materials, known = m.images.find(i => i.assetId === added.id);
    if (known) return { label: known.label, url: added.url };
    const label = `X${m.images.filter(i => i.label.startsWith('X')).length + 1}`;
    m.images.push({ label, assetId: added.id });
    m.sorted.images.push({ id: label, kind: '颜色款图', color: '', front: true, detail: '', text: false, logo: false, same: '', person: '', face: false });
    await c.query(`UPDATE listing_projects SET materials=$2,updated_at=now() WHERE id=$1`, [projectId, m]);
    return { label, url: added.url };
  });
}

/** The pictures the writing step reads: one per colour, the structure references, the sources of the points on the images. */
async function writeViews(projectId: string, m: Materials, draft: SubmittedDraft) {
  // Labels come from the materials (fixed when sorted), not from the current file order.
  const assets = (await db().query(`SELECT id,file_id FROM listing_assets WHERE project_id=$1 AND kind='source'`, [projectId])).rows as { id: string; file_id: string }[];
  const fileOf = new Map(assets.map(a => [a.id, a.file_id]));
  const rows = new Map(m.images.filter(i => fileOf.has(i.assetId)).map(i => [i.label, fileOf.get(i.assetId)!]));
  const wanted = new Map<string, { text: string; side: number }>();
  for (const c of draft.colors) {
    const shared = draft.colors.filter(x => x.pick === c.pick).map(x => x.name);
    wanted.set(c.pick!, { text: shared.length > 1 ? `【${c.pick}】合照，颜色「${shared.join('」「')}」的衣服都以它里面对应颜色的那件为准` : `【${c.pick}】颜色「${c.name}」的衣服图（这个颜色以它为准）`, side: 768 });
  }
  for (const part of draft.parts) if (part.pick && !wanted.has(part.pick)) wanted.set(part.pick, { text: `【${part.pick}】结构参考：${part.part}`, side: 768 });
  // Where the material's models were photographed: the set's SKU models and closer are shot there too.
  for (const i of m.sorted.images.filter(x => x.kind === '模特实拍' && x.person && !x.same && !wanted.has(x.id)).slice(0, 2)) wanted.set(i.id, { text: `【${i.id}】素材里的模特实拍（看拍摄地点）`, side: 768 });
  // The pictures the points on the images came from: what a card demonstrates is drawn from them.
  const shown = new Set(usedSlots(draft, draft.counts.square).flatMap(i => draft.slots[i].cells.map(x => x.point)));
  const sources = [...new Set(draft.points.filter(x => shown.has(x.id)).flatMap(x => x.from))].filter(id => !wanted.has(id)).slice(0, 12);
  for (const id of sources) wanted.set(id, { text: `【${id}】卖点出处`, side: 1024 });
  return Promise.all([...wanted].filter(([label]) => rows.has(label)).map(async ([label, v]) => {
    const jpeg = await sharp((await readCatalogFile(rows.get(label)!)).bytes, { limitInputPixels: 60_000_000 }).rotate().resize(v.side, v.side, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
    return { text: v.text, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
  }));
}

/** Writing did not finish: the held credits go back and the product returns to the plan page. */
async function backToPlan(projectId: string, tenantId: string, runId: string | undefined, error: string) {
  if (runId) await releaseHold(runHold(runId), tenantId, '写画面没完成').catch(() => {});
  await db().query(`UPDATE listing_projects SET status='materials',error=$2,updated_at=now() WHERE id=$1 AND status='writing'`, [projectId, error]);
}

/**
 * Describe the garment and write each image's picture, then queue every image under the credits
 * held when the user started. Free; a failure returns the credits and the product to the plan page.
 */
export async function executeWrite(job: JobRow, provider: Provider = (request, hooks) => callPlanModel(request, hooks)) {
  const attemptId = randomUUID(), model = LISTING_PLAN_MODEL();
  const p = (await db().query('SELECT name,materials FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
  const m = p.materials as Materials, draft = m?.draft;
  try {
    if (!draft) throw new CatalogHttpError(409, '还没有定方案');
    const layout = await resolveLayout(job.tenant_id, draft.layout);
    if (!layout) throw new CatalogHttpError(404, '版式不存在');
    const views = await writeViews(job.project_id, m, draft);
    const call = await provider(writeRequest({ views, draft, layout, model, product: p.name }), {
      beforeSubmit: async () => { await db().query(`INSERT INTO listing_attempts(id,job_id,provider,model,status) VALUES($1,$2,$3,$4,'submitted')`, [attemptId, job.id, listingPlanProvider(), model]); },
      receipt: async id => { await db().query('UPDATE listing_attempts SET provider_request_id=$2 WHERE id=$1', [attemptId, id]); },
    });
    await db().query(`UPDATE listing_attempts SET status='succeeded',receipt=$2,finished_at=now() WHERE id=$1`, [attemptId, { model: call.model, usage: call.usage, durationMs: call.durationMs }]);
    const stored = buildPlan(call.content, { draft, images: m.images, direct: directKeys(draft.colors, m.sorted.images), photos: skuPhotos(draft, m.sorted.images, skuPair(layout)), sorted: m.sorted.images, model: call.model });
    // A copy's carried-over white images and cast are kept, not drawn again (listing-copy).
    const reused = reusedSlots(draft, m.reuse), jobs = planJobs(stored, layout, 1).filter(j => !reused.has(j.slot));
    await catalogTransaction(async c => {
      const hold = (await c.query('SELECT state FROM credit_holds WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [runHold(draft.runId), job.tenant_id])).rows[0];
      if (hold?.state !== 'held') throw new Error('出图的积分冻结已失效');
      const user = (await c.query('SELECT created_by FROM listing_jobs WHERE id=$1', [job.id])).rows[0].created_by;
      await c.query(`UPDATE listing_projects SET plan=$2 WHERE id=$1`, [job.project_id, stored]);
      await insertJobs(c, job.tenant_id, user, job.project_id, draft.runId, jobs);
      await c.query(`UPDATE listing_jobs SET status='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id]);
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : '写画面失败').slice(0, 300);
    await db().query(`UPDATE listing_attempts SET status=CASE WHEN status='succeeded' THEN status ELSE 'failed' END,finished_at=now() WHERE id=$1`, [attemptId]).catch(() => {});
    await db().query(`UPDATE listing_jobs SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, message]);
    await backToPlan(job.project_id, job.tenant_id, draft?.runId, `写画面没成功：${message}。冻结的积分已退回，可以再点一次开始出图`);
  }
}

/**
 * Runs up to `LISTING_WORKER_CONCURRENCY` jobs at once (images mostly wait on the provider; 4 on
 * the Codex relay, which rate-limits more). An
 * image job starts only when the images it builds on exist; if one of them failed, it is
 * skipped and costs nothing.
 */
/** How long one round of the worker loop may take before it is left behind; a round is normally well under a second. */
const ROUND_LIMIT_MS = 120_000;
/**
 * Run one round of the worker loop, waiting at most `limitMs`: a round that hangs (a call that never
 * answers) is left behind and `onStuck` says so, so the loop is not stopped for good by it.
 */
export async function roundWithin(round: () => Promise<void>, limitMs: number, onStuck: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), limitMs); });
  try { if (await Promise.race([round().then(() => false), stuck])) onStuck(); } finally { clearTimeout(timer); }
}

export async function startListingWorker({ canAccept = () => true, concurrency = listingWorkerConcurrency(), generate, upscale, recognize, learn }: { canAccept?: () => boolean; concurrency?: number; generate?: Parameters<typeof executeImage>[1]; upscale?: Upscale; recognize?: Parameters<typeof executeImage>[3]; learn?: Parameters<typeof executeLayout>[1] } = {}) {
  let closed = false, ticking = false;
  const running = new Set<Promise<void>>(), owner = randomUUID();
  const heartbeat = () => db().query('INSERT INTO listing_workers(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()', [owner]);
  await heartbeat();
  const beatTimer = setInterval(() => { void heartbeat().catch(() => {}); }, 15000);
  const sweep = async () => {
    // A job whose worker vanished: never resend; plans settle here, image runs when they finish.
    const expired = (await db().query(`UPDATE listing_jobs SET status='unknown',error='后台中断，未重复调用模型；可能已产生费用，由管理员核对',lease_until=NULL
      WHERE status='running' AND lease_until<now() RETURNING id,tenant_id,project_id,step,run_id`)).rows;
    for (const j of expired) {
      if (j.step === 'write') {
        const runId = (await db().query(`SELECT materials->'draft'->>'runId' run FROM listing_projects WHERE id=$1`, [j.project_id])).rows[0]?.run;
        await backToPlan(j.project_id, j.tenant_id, runId, '写画面时后台中断，冻结的积分已退回，可以再点一次开始出图'); continue;
      }
      if (j.step !== 'plan') { await finishRun(j.run_id, j.tenant_id, j.project_id); continue; }
      const attempts = (await db().query('SELECT id,status FROM listing_attempts WHERE job_id=$1', [j.id])).rows;
      const progress = (await db().query('SELECT 1 FROM listing_plan_parts WHERE project_id=$1 LIMIT 1', [j.project_id])).rowCount;
      if (progress) await releaseHold(holdId(j.id), j.tenant_id, '后台中断，已存进度，继续整理做完时再计费').catch(() => {});
      else if (attempts.length) await settleHold(holdId(j.id), j.tenant_id, attempts.map(a => ({ action: 'listing_plan' as const, billable: true, certain: a.status === 'succeeded', attemptId: a.id }))).catch(() => {});
      else await releaseHold(holdId(j.id), j.tenant_id, '后台在提交前中断').catch(() => {});
      await db().query(`UPDATE listing_projects SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='planning'`, [j.project_id, progress ? '整理到一半后台中断了，进度已保存。点「继续整理」只做剩下的，这次不扣费' : '后台中断，请重新分析']);
    }
  };
  type Claimed = { id: string; tenant_id: string; project_id: string; step: string; run_id: string; slot: string; input: JobInput; depends: string[] };
  const claim = () => catalogTransaction(async c => {
    const queued = (await c.query(`SELECT j.id,j.tenant_id,j.project_id,j.step,j.run_id,j.slot,j.input,j.depends FROM listing_jobs j JOIN tenants t ON t.id=j.tenant_id
      WHERE j.status='queued' AND NOT t.disabled ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 30`)).rows as Claimed[];
    for (const j of queued) {
      if (j.depends.length) {
        // A prerequisite remade in the same run must finish first: an older image of that slot
        // (say, a product image being redone) must not be used.
        const same = (await c.query(`SELECT DISTINCT ON (slot) slot,status FROM listing_jobs WHERE run_id=$1 AND slot = ANY($2) ORDER BY slot, created_at DESC`, [j.run_id, j.depends])).rows as { slot: string; status: string }[];
        const broken = same.find(d => d.status === 'failed' || d.status === 'unknown');
        if (broken) return { blocked: j, reason: `前一步「${broken.slot}」没做出来` };
        if (same.some(d => d.status !== 'succeeded')) continue;
        const have = (await c.query(`SELECT count(DISTINCT slot)::int n FROM listing_assets WHERE project_id=$1 AND slot = ANY($2)`, [j.project_id, j.depends])).rows[0].n;
        if (have < j.depends.length) return { blocked: j, reason: '前一步的图找不到了' };
      }
      await c.query(`UPDATE listing_jobs SET status='running',owner=$2,lease_until=now()+interval '3 minutes' WHERE id=$1`, [j.id, owner]);
      return { job: j };
    }
    return null;
  });
  const run = (job: Claimed) => {
    const beat = setInterval(() => { void db().query(`UPDATE listing_jobs SET lease_until=now()+interval '3 minutes' WHERE id=$1 AND owner=$2 AND status='running'`, [job.id, owner]).catch(() => {}); }, 15000);
    const task = (job.step === 'plan' ? executePlan(job) : job.step === 'write' ? executeWrite(job) : executeImage(job, generate, upscale, recognize))
      .catch(error => console.error('[listing-worker]', error instanceof Error ? error.message : 'error'))
      .finally(() => { clearInterval(beat); running.delete(task); });
    running.add(task);
  };
  let clearedAt = 0;
  let rounds = 0;
  const tick = async () => {
    if (closed || ticking || !canAccept()) return;
    ticking = true;
    // A round left behind as stuck takes no more jobs; one it already claimed still runs.
    const round = ++rounds, live = () => !closed && round === rounds;
    let stage = '收回中断的任务';
    try {
      await roundWithin(async () => {
        try {
          await sweep();
          // Old products' source images: checked hourly; an advisory lock keeps the workers apart.
          // Expired quota reservations go back in the same hour; without it a crashed upload held
          // its capacity for good.
          if (Date.now() - clearedAt > 3600_000) {
            clearedAt = Date.now(); stage = '清理旧素材';
            await clearOldSources().catch(error => console.error('[listing-worker] clear', error instanceof Error ? error.message : 'error'));
            await sweepExpiredReservations().catch(error => console.error('[listing-worker] quota sweep', error instanceof Error ? error.message : 'error'));
          }
          while (live() && running.size < concurrency) {
            stage = '领任务';
            const next = await claim();
            if (!next) break;
            if ('blocked' in next && next.blocked) { stage = '标记前一步没做出来'; await failBlocked(next.blocked, next.reason!); continue; }
            if ('job' in next && next.job) run(next.job);
          }
          // A layout to learn: one call to read the references, then three sample images.
          if (live() && running.size < concurrency) {
            stage = '领版式学习';
            const layout = await claimLayout(owner);
            if (layout) {
              const beat = setInterval(() => { void renewLayoutLease(layout.id, owner).catch(() => {}); }, 15000);
              const task = executeLayout(layout, learn).catch(error => console.error('[listing-worker] layout', error instanceof Error ? error.message : 'error'))
                .finally(() => { clearInterval(beat); running.delete(task); });
              running.add(task);
            }
          }
        } catch (error) { console.error('[listing-worker]', error instanceof Error ? error.name : 'error'); }
      }, ROUND_LIMIT_MS, () => console.error(`[listing-worker] 这一轮卡在「${stage}」超过 ${ROUND_LIMIT_MS / 1000} 秒，先放下，下一轮照常领任务`));
    } finally { ticking = false; }
  };
  const timer = setInterval(() => void tick(), 2000);
  void tick();
  return {
    running: () => running.size,
    close: async () => {
      closed = true; clearInterval(timer); clearInterval(beatTimer); await Promise.all(running);
      await db().query(`UPDATE listing_workers SET heartbeat_at=now()-interval '1 day' WHERE id=$1`, [owner]);
    },
  };
}
