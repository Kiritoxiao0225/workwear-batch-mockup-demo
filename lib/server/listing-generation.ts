/**
 * 电商主图 generation: turn the written plan into image jobs in two rounds, run them in dependency
 * order and settle each run's credits once all of its jobs have finished.
 *
 *   product:<sku>  white-background product image of one colour (from its garment image)
 *   cast           the models every image with people is drawn from (one man, one woman)
 *   sku:<sku>      SKU image; colours after the main one copy the main colour's SKU image
 *   square:<n>     round one: the square images; portrait:<n> and long:1 round two (「出竖版」)
 *   square:1+<sku> / portrait:1+<sku> / long:1+<sku>   the covers of an extra set in that colour
 *
 * A 画板 change remakes one main image from its current version: only the box is redrawn and
 * pasted back. After every main image the things on it are found (listing-recognize).
 */
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { z } from 'zod';
import type { CanvasEdit, Element, Words } from '../listing/api-types';
import { categoryById, TASK_LABEL, type Task } from '../listing/category';
import { usedSlots } from '../listing/draft';
import type { SubmittedDraft } from '../listing/draft-schema';
import { proofById, recipeOf } from '../listing/proofs';
import { cellZones, fitTemplate, needsCast, type Box, type Layout, type Template } from '../listing/templates';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile } from './catalog-files';
import { currentPrices, holdCredits, microToCents, priceOf, settleHold, type AttemptOutcome, type PriceSnapshot } from './credits';
import { maskOf, pad, pasteBack } from './listing-edit';
import { resolveLayout } from './listing-layouts';
import { castPrompt, editPrompt, mainPrompt, productPrompt, skuPrompt, type Content, type Ratio } from './listing-prompts';
import { callPlanModel, generateListingImage, LISTING_IMAGE_MODEL, LISTING_PLAN_MODEL, type ImageCall, type PlanCall } from './listing-provider';
import { parseRecognized, recognizeRequest, type Expected } from './listing-recognize';
import { latestOutputs, MAIN_SLOT, storeOutput, type StoredPlan } from './listing-store';
import { upscaleListingImage } from './listing-upscale';
import type { Tenant } from './tenant-scope';

/** A 画板 change: the version it starts from and what to redraw where; `change` says it in words for the version list. */
type EditInput = Omit<CanvasEdit, 'slot' | 'base'> & { base: string; change: string };
/**
 * A main image: its shape, the plan's image it shows (`index` into the draft's images, -1 for the
 * long image), its colours, the words it is made with (kept with each version) and, for a 画板
 * change, the edit. `layout`: an extra set's own layout. `note`: the user's extra request on a redo.
 */
export type JobInput = (
  | { kind: 'product'; sku: string; direct?: boolean }
  | { kind: 'cast' }
  | { kind: 'sku'; sku: string; anchor?: string }
  | { kind: 'main'; ratio: Ratio; index: number; n: number; total: number; skus: string[]; colors: string[]; words: Words; layout?: string; edit?: EditInput }
) & { note?: string };
type PlannedJob = { slot: string; step: 'product' | 'image'; input: JobInput; depends: string[]; multi: boolean; free?: boolean };
const db = () => catalogDatabase();
export const runHold = (runId: string) => 'listing:run:' + runId;
const action = (input: JobInput) => input.kind === 'main' && input.skus.length > 1 && !input.edit ? 'listing_image_multi' as const : 'listing_image' as const;

/* ---------- planning the jobs ---------- */

/** The template a main image is drawn on. */
const templateOf = (layout: Layout, d: SubmittedDraft, input: { ratio: Ratio; index: number; words: Words }): Template =>
  input.index < 0 ? layout.long : fitTemplate(layout.templates[d.slots[input.index].task as Task][input.ratio as 'square' | 'portrait'], input.words.cells.length);
/** The words an image is made with: its own, each card's from its point. */
export function wordsOf(d: SubmittedDraft, index: number): Words {
  if (index < 0) return { title: d.long.title, sub: '', tags: [], cells: [] };
  const s = d.slots[index];
  return { title: s.title, sub: s.sub, tags: s.tags, cells: s.cells.map(c => ({ ...c, caption: d.points.find(p => p.id === c.point)?.text ?? '' })) };
}
/** What a main image depends on: its colours' images, and the cast when it has people. */
const mainDepends = (skus: string[], people: boolean) => [...(skus.length > 1 ? skus.map(s => `sku:${s}`) : [`product:${skus[0]}`]), ...(people ? ['cast'] : [])];

/**
 * The jobs of one round. Round one: every colour's product image, the cast (when any image has
 * people), every colour's SKU image and the square images. Round two: the 3:4 images (from the
 * square images' current words) and the long image. `only` keeps one extra set (its colour's label).
 */
export function planJobs(stored: StoredPlan, layout: Layout, round: 1 | 2, only?: string): PlannedJob[] {
  const d = stored.draft, main = stored.colors[0]?.sku, skuOf = new Map(stored.colors.map(c => [c.name, c.sku]));
  if (!main) throw new CatalogHttpError(409, '没有颜色，出不了图');
  const tasks = categoryById(d.category).tasks, cast = needsCast(layout, tasks), jobs: PlannedJob[] = [];
  const mainJob = (slot: string, ratio: Ratio, index: number, n: number, total: number, colors: string[], extraLayout?: string): PlannedJob => {
    const skus = colors.map(c => skuOf.get(c)!).filter(Boolean), words = wordsOf(d, index);
    const t = templateOf(layout, d, { ratio, index, words });
    return { slot, step: 'image', input: { kind: 'main', ratio, index, n, total, skus, colors, words, ...(extraLayout ? { layout: extraLayout } : {}) }, depends: mainDepends(skus, cast && t.people > 0), multi: skus.length > 1 };
  };
  if (round === 1 && !only) {
    for (const c of stored.colors) jobs.push({ slot: `product:${c.sku}`, step: 'product', input: { kind: 'product', sku: c.sku, ...(stored.direct.includes(c.sku) ? { direct: true } : {}) }, depends: [], multi: false, free: stored.direct.includes(c.sku) });
    if (cast) jobs.push({ slot: 'cast', step: 'image', input: { kind: 'cast' }, depends: [`product:${main}`], multi: false });
    for (const c of stored.colors) {
      const anchor = c.sku === main ? undefined : main;
      jobs.push({ slot: `sku:${c.sku}`, step: 'image', input: { kind: 'sku', sku: c.sku, anchor }, depends: [`product:${c.sku}`, ...(cast && layout.sku.people ? ['cast'] : []), ...(anchor ? [`sku:${anchor}`] : [])], multi: false });
    }
  }
  const ratios: Ratio[] = round === 1 ? ['square'] : ['portrait'];
  for (const ratio of ratios) {
    const n = ratio === 'square' ? d.counts.square : Math.min(d.counts.portrait, d.counts.square), used = usedSlots(d, n);
    if (!only) used.forEach((i, k) => jobs.push(mainJob(`${ratio}:${k + 1}`, ratio, i, k + 1, used.length, d.slots[i].colors.length ? d.slots[i].colors : [d.main])));
    for (const e of d.extra) if (n && (!only || skuOf.get(e.color) === only)) jobs.push(mainJob(`${ratio}:1+${skuOf.get(e.color)}`, ratio, 0, 1, used.length, [e.color], e.layout || undefined));
  }
  if (round === 2 && d.counts.long) {
    if (!only) jobs.push(mainJob('long:1', 'long', -1, 1, 1, [d.main]));
    for (const e of d.extra) if (!only || skuOf.get(e.color) === only) jobs.push(mainJob(`long:1+${skuOf.get(e.color)}`, 'long', -1, 1, 1, [e.color], e.layout || undefined));
  }
  return jobs;
}

export const priceFor = (prices: PriceSnapshot, jobs: { multi: boolean; free?: boolean }[]) =>
  jobs.reduce((sum, job) => sum + (job.free ? 0 : priceOf(prices, job.multi ? 'listing_image_multi' : 'listing_image').userMicroCents), 0);

/** Hold a run's credits before any of its jobs exists. */
export async function holdRun(c: CatalogQueryClient, tenant: Tenant, projectId: string, jobs: { multi: boolean; free?: boolean }[], prices: PriceSnapshot, runId = randomUUID()) {
  if (!(await c.query("SELECT 1 FROM listing_workers WHERE heartbeat_at>now()-interval '45 seconds' LIMIT 1")).rowCount) {
    throw new CatalogHttpError(503, '电商主图后台未连接，未冻结积分，请稍后再试');
  }
  await holdCredits(c, { id: runHold(runId), tenantId: tenant.id, kind: 'production', jobRef: `listing:run:${projectId}:${runId}`,
    billingMode: tenant.billingMode, amountCents: microToCents(priceFor(prices, jobs)), snapshot: prices });
  return runId;
}

/** Queue a run's jobs under its held credits. */
export async function insertJobs(c: CatalogQueryClient, tenantId: string, user: string, projectId: string, runId: string, jobs: PlannedJob[]) {
  for (const job of jobs) {
    // clock_timestamp, not now(): jobs of one run keep their dependency order in the queue.
    await c.query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step,run_id,slot,input,depends,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,
      [randomUUID(), tenantId, projectId, user, job.step, runId, job.slot, job.input, job.depends]);
  }
  await c.query(`UPDATE listing_projects SET status='generating', error=NULL, updated_at=now() WHERE id=$1`, [projectId]);
}

async function queueRun(c: CatalogQueryClient, tenant: Tenant, user: string, projectId: string, jobs: PlannedJob[], prices: PriceSnapshot) {
  if (!jobs.length) throw new CatalogHttpError(409, '没有要出的图');
  const runId = await holdRun(c, tenant, projectId, jobs, prices);
  await insertJobs(c, tenant.id, user, projectId, runId, jobs);
  return runId;
}

/** A product of this tenant, locked, with its plan; `states` it must be in. */
async function lockProject(c: CatalogQueryClient, tenant: Tenant, projectId: string, states: string[], wrong: string) {
  const p = (await c.query(`SELECT status,layout,plan FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
  if (!p) throw new CatalogHttpError(404, '商品不存在');
  if (!states.includes(p.status) || !p.plan) throw new CatalogHttpError(409, wrong);
  const layout = await resolveLayout(tenant.id, p.plan.draft.layout);
  if (!layout) throw new CatalogHttpError(400, '版式不存在');
  return { status: p.status as string, stored: p.plan as StoredPlan, layout };
}

/* ---------- what the user starts after round one ---------- */

/** 「出竖版」: the 3:4 images and the long image, from the square images as the 画板 left them. */
export async function startVerticals(tenant: Tenant, user: string, projectId: string) {
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const { stored, layout } = await lockProject(c, tenant, projectId, ['square'], '方图出完才能出竖版');
    const jobs = planJobs(stored, layout, 2);
    await queueRun(c, tenant, user, projectId, jobs, prices);
    await c.query('UPDATE listing_projects SET plan=$2 WHERE id=$1', [projectId, { ...stored, round: 2 }]);
    return { status: 'generating', images: jobs.length };
  });
}

/** The newest job of each slot, for remaking images from what they were made with. */
async function latestJobs(c: CatalogQueryClient, projectId: string) {
  return (await c.query(`SELECT DISTINCT ON (slot) slot,step,input,depends,status,error FROM listing_jobs WHERE project_id=$1 AND slot IS NOT NULL ORDER BY slot, created_at DESC`, [projectId])).rows as
    { slot: string; step: 'product' | 'image'; input: JobInput; depends: string[]; status: string; error: string | null }[];
}

/** 「换一组模特」: a new cast and every image with people redrawn whole from its current words. */
export async function recast(tenant: Tenant, user: string, projectId: string) {
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    await lockProject(c, tenant, projectId, ['square', 'done'], '出过图之后才能换模特');
    const latest = await latestJobs(c, projectId);
    if (!latest.some(j => j.slot === 'cast')) throw new CatalogHttpError(409, '这个版式没有模特');
    if ((await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1`, [projectId])).rowCount) throw new CatalogHttpError(409, '还有图在出，等出完再换');
    const jobs: PlannedJob[] = [];
    for (const j of latest) {
      if (!j.depends.includes('cast') && j.slot !== 'cast') continue;
      const input = j.input.kind === 'main' ? { ...j.input, edit: undefined, note: undefined } : j.input;
      jobs.push({ slot: j.slot, step: j.step, input, depends: j.depends, multi: action(input) === 'listing_image_multi' });
    }
    jobs.sort((a, b) => Number(b.slot === 'cast') - Number(a.slot === 'cast') || Number(b.slot.startsWith('sku')) - Number(a.slot.startsWith('sku')));
    await queueRun(c, tenant, user, projectId, jobs, prices);
    return { images: jobs.length };
  });
}

/** One more cover set in another colour: its square cover now, its 3:4 and long covers too once round two has run. */
export async function addSet(tenant: Tenant, user: string, projectId: string, input: unknown) {
  const b = z.object({ color: z.string().min(1), layout: z.string().default('') }).parse(input);
  if (b.layout && !(await resolveLayout(tenant.id, b.layout, { forNewProject: true }))) throw new CatalogHttpError(400, '没有这个版式');
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const { stored, layout } = await lockProject(c, tenant, projectId, ['square', 'done', 'generating'], '出过图之后才能再加一套');
    const color = stored.colors.find(x => x.name === b.color);
    if (!color) throw new CatalogHttpError(400, '没有这个颜色');
    if (color === stored.colors[0] || stored.draft.extra.some(e => e.color === b.color)) throw new CatalogHttpError(409, `「${b.color}」已经有首图了`);
    const next: StoredPlan = { ...stored, draft: { ...stored.draft, extra: [...stored.draft.extra, { color: b.color, layout: b.layout }] } };
    const jobs = [...planJobs(next, layout, 1, color.sku), ...(stored.round === 2 ? planJobs(next, layout, 2, color.sku) : [])];
    await queueRun(c, tenant, user, projectId, jobs, prices);
    await c.query('UPDATE listing_projects SET plan=$2 WHERE id=$1', [projectId, next]);
    return { status: 'generating', images: jobs.length };
  });
}

/** Make one image again from what it was made with (a 画板 change is not repeated); earlier versions stay. */
export async function redoSlot(tenant: Tenant, user: string, projectId: string, slot: string, note: string) {
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    await lockProject(c, tenant, projectId, ['square', 'done', 'generating'], '出过图之后才能单张重做');
    const latest = await latestJobs(c, projectId), last = latest.find(j => j.slot === slot);
    if (!last) throw new CatalogHttpError(404, '没有这张图');
    if (last.status === 'queued' || last.status === 'running') throw new CatalogHttpError(409, '这张图正在出，等它出完再重做');
    const input = { ...last.input, ...(last.input.kind === 'main' ? { edit: undefined } : {}), note: note.trim().slice(0, 200) || undefined } as JobInput;
    const free = (x: JobInput) => x.kind === 'product' && !!x.direct;
    const jobs: PlannedJob[] = [{ slot, step: last.step, input, depends: last.depends, multi: action(input) === 'listing_image_multi', free: free(input) }];
    // Images that were skipped because this one (or one of them) was missing come along.
    const skipped = latest.filter(j => j.slot !== slot && j.status === 'failed' && String(j.error).startsWith('前一步'));
    for (let grew = true; grew;) {
      grew = false;
      for (const j of skipped) if (!jobs.some(q => q.slot === j.slot) && j.depends.some(d => jobs.some(q => q.slot === d))) {
        jobs.push({ slot: j.slot, step: j.step, input: j.input, depends: j.depends, multi: action(j.input) === 'listing_image_multi', free: free(j.input) }); grew = true;
      }
    }
    await queueRun(c, tenant, user, projectId, jobs, prices);
    return { status: 'generating', images: jobs.length };
  });
}

const boxSchema = z.tuple([z.number().min(0).max(100), z.number().min(0).max(100), z.number().min(1).max(100), z.number().min(1).max(100)]);
const editSchema = z.object({
  slot: z.string().regex(MAIN_SLOT), base: z.uuid(), mode: z.enum(['cell', 'text', 'free', 'move']), zone: z.string().max(20).optional(), box: boxSchema, to: boxSchema.optional(),
  point: z.string().max(40).optional(), proof: z.string().max(40).optional(), caption: z.string().trim().max(20).optional(), text: z.string().trim().max(30).optional(), request: z.string().trim().max(200).optional(),
});
/** A 画板 change: one main image remade from the version the user is looking at. */
export async function editSlot(tenant: Tenant, user: string, projectId: string, body: unknown) {
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) throw new CatalogHttpError(400, '这次修改的内容不完整');
  const e = parsed.data;
  if (e.mode === 'free' && !e.request) throw new CatalogHttpError(400, '写一下框里要画什么');
  if (e.mode === 'move' && !e.to) throw new CatalogHttpError(400, '先把它拖到新位置');
  if ((e.mode === 'cell' || e.mode === 'text' || e.mode === 'move') && !e.zone) throw new CatalogHttpError(400, '先选中图上的一块');
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const { stored } = await lockProject(c, tenant, projectId, ['square', 'done'], '出过图之后才能在画板上改');
    const base = (await c.query(`SELECT a.id,j.input,j.depends FROM listing_assets a JOIN listing_jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.project_id=$2 AND a.slot=$3`, [e.base, projectId, e.slot])).rows[0];
    if (!base?.input || base.input.kind !== 'main') throw new CatalogHttpError(404, '没有这个版本');
    if ((await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND slot=$2 AND status IN ('queued','running')`, [projectId, e.slot])).rowCount) throw new CatalogHttpError(409, '这张图正在出，等它出完再改');
    const from = base.input as Extract<JobInput, { kind: 'main' }>, point = e.point ? stored.draft.points.find(p => p.id === e.point) : undefined;
    if (e.mode === 'cell' && (!point || !point.on)) throw new CatalogHttpError(400, '没有这条卖点');
    const change = e.mode === 'cell' ? `换了一格：${e.caption || point?.text}` : e.mode === 'text' ? (e.text ? `改字：${e.text}` : '去掉了一句字') : e.mode === 'move' ? '挪了位置' : `重画了一块：${e.request}`;
    const words = editedWords(from.words, e, point?.text);
    const input: JobInput = { ...from, words, edit: { ...e, base: base.id, change }, note: undefined };
    // Its prerequisites stay those of the image, so 「换一组模特」 still finds it.
    await queueRun(c, tenant, user, projectId, [{ slot: e.slot, step: 'image', input, depends: base.depends ?? [], multi: false }], prices);
    return { images: 1 };
  });
}

/** The words an image has after a 画板 change. */
function editedWords(w: Words, e: z.infer<typeof editSchema>, pointText?: string): Words {
  const k = e.zone ? Number(e.zone.replace(/\D/g, '')) - 1 : -1;
  if (e.mode === 'text' && e.zone?.startsWith('title')) return { ...w, title: e.text ?? '' };
  if (e.mode === 'text' && e.zone?.startsWith('sub')) return { ...w, sub: e.text ?? '' };
  if (e.mode === 'text' && e.zone?.startsWith('tag')) { const tags = [...w.tags]; tags[k] = e.text ?? ''; return { ...w, tags: tags.filter(Boolean) }; }
  if (e.mode === 'cell' && k >= 0) return { ...w, cells: w.cells.map((c, i) => i === k ? { point: e.point ?? c.point, proof: e.proof ?? c.proof, caption: e.caption || pointText || c.caption } : c) };
  return w;
}

/* ---------- making one image ---------- */

type ImageJob = { id: string; tenant_id: string; project_id: string; run_id: string; slot: string; input: JobInput };
type Generate = (input: Parameters<typeof generateListingImage>[0], hooks: { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> }) => Promise<ImageCall>;
export type Upscale = typeof upscaleListingImage;
type Recognize = (request: object) => Promise<PlanCall>;

async function fileOf(fileId: string) { return (await readCatalogFile(fileId)).bytes; }

/** What a main image's zones show: words, each card's picture, the models' demonstration and the scene. */
function contentOf(stored: StoredPlan, input: Extract<JobInput, { kind: 'main' }>, slot: string): Content {
  const d = stored.draft, s = input.index >= 0 ? d.slots[input.index] : undefined;
  const cells = input.words.cells.map(c => {
    const p = d.points.find(x => x.id === c.point), proof = proofById(c.proof);
    return { text: c.caption, recipe: proof ? recipeOf(proof, p?.part || p?.text) : '', icon: proof?.kind === '图标文字' && proof.id === 'icon-text' };
  });
  const scene = stored.scenes[slot.split('+')[0]] ?? stored.scenes[`${input.ratio}:1`] ?? '';
  const act = s?.act ? proofById(s.act)?.recipe : undefined;
  return { title: input.words.title, sub: input.words.sub, tags: input.words.tags, cells, act, scene };
}

/** What recognition looks for on a main image: the zones that carry something. */
function expectedOf(t: Template, w: Words): Expected[] {
  const cells = cellZones(t);
  return t.zones.flatMap(z => {
    const n = Number(z.id.replace(/\D/g, '')) - 1;
    const text = z.kind === 'title' ? w.title : z.kind === 'sub' ? w.sub : z.kind === 'tag' ? w.tags[n] : cells.includes(z) ? w.cells[cells.indexOf(z)]?.caption : undefined;
    if ((z.kind === 'title' || z.kind === 'sub' || z.kind === 'tag' || cells.includes(z)) && !text) return [];
    return [{ zone: z.id, kind: z.kind, ...(text ? { text } : {}) }];
  });
}

/** What a 画板 change asks to draw inside its box. */
function editWhat(stored: StoredPlan, e: EditInput, from: Words, layout: Layout) {
  if (e.mode === 'text') return e.text ? `把这里原来的字换成「${e.text}」，字体、字号、颜色和位置照原来的。` : '把这里的字去掉，补成和周围一致的背景。';
  if (e.mode === 'free' || e.mode === 'move') return e.request ?? '原来那一块，样式照原来的。';
  const p = stored.draft.points.find(x => x.id === e.point), proof = proofById(e.proof ?? '');
  return `一张卡片，${layout.style.card}。卡片里画：${proof ? recipeOf(proof, p?.part || p?.text) : ''}；卡片底部一行字「${e.caption || p?.text || ''}」，字的样式和旁边的卡片一样。${from.title ? `（这张图的大标题是「${from.title}」，不要改它。）` : ''}`;
}

/** One image: gather the reference images it depends on, call the generator, keep the result, find what is on it. */
export async function executeImage(job: ImageJob, generate: Generate = (input, hooks) => generateListingImage(input, hooks), upscale: Upscale = upscaleListingImage,
  recognize: Recognize = request => callPlanModel(request, { beforeSubmit: async () => {}, receipt: async () => {} })) {
  const attemptId = randomUUID();
  let submitted = false;
  try {
    const p = (await db().query('SELECT plan FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
    const stored = p.plan as StoredPlan, input = job.input, d = stored.draft;
    const layout = await resolveLayout(job.tenant_id, (input.kind === 'main' && input.layout) || d.layout);
    if (!layout) throw new Error('版式不存在');
    const colors = stored.colors, outputs = await latestOutputs(job.project_id), garment = stored.garment, main = colors[0];
    const output = async (slot: string) => { const o = outputs.get(slot); if (!o) throw new Error(`缺少前一步的图：${slot}`); return fileOf(o.file_id); };
    const colorOf = (sku: string) => colors.find(c => c.sku === sku) ?? (() => { throw new Error(`颜色不存在：${sku}`); })();
    const hasCast = outputs.has('cast');
    let prompt: string, references: Buffer[], ratio: Ratio = 'square', mask: Buffer | undefined, paste: { original: Buffer; boxes: Box[] } | undefined;
    if (input.kind === 'product') {
      const assetId = stored.images.find(i => i.label === input.sku)?.assetId;
      const source = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [assetId])).rows[0];
      if (!source) throw new Error('找不到这个颜色的衣服图（原始素材可能已在最后一次出图 30 天后清理）');
      if (input.direct) {
        // The colour's own clean still life, on a white square: no model call, nothing charged.
        const square = await sharp(await fileOf(source.file_id), { limitInputPixels: 60_000_000 }).rotate().flatten({ background: '#ffffff' })
          .resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
        const asset = await storeOutput(job.tenant_id, job.project_id, job.slot, job.id, square);
        await db().query(`UPDATE listing_jobs SET status='succeeded',result_asset=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, asset]);
        return;
      }
      prompt = productPrompt({ color: colorOf(input.sku).name, garment });
      references = [await fileOf(source.file_id)];
    } else if (input.kind === 'cast') {
      prompt = castPrompt({ color: main.name, garment });
      references = [await output(`product:${main.sku}`)];
      ratio = 'portrait';
    } else if (input.kind === 'sku') {
      const people = layout.sku.people > 0 && hasCast;
      references = [await output(`product:${input.sku}`), ...(people ? [await output('cast')] : []), ...(input.anchor ? [await output(`sku:${input.anchor}`)] : [])];
      prompt = skuPrompt({ layout, color: colorOf(input.sku).name, tag: stored.sku.tag, fabric: stored.sku.fabric, garment, lead: d.model.lead,
        cast: people ? 2 : null, anchor: input.anchor ? (people ? 3 : 2) : null, anchorColor: input.anchor ? colorOf(input.anchor).name : undefined });
    } else if (input.edit) {
      // A 画板 change: the current version at 1K is the reference; only the box is redrawn.
      const base = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND project_id=$2', [input.edit.base, job.project_id])).rows[0];
      if (!base) throw new Error('找不到要改的那一版图');
      const original = await fileOf(base.file_id), small = await sharp(original).resize(1024, 1024, { fit: 'inside' }).png().toBuffer();
      const meta = await sharp(small).metadata(), boxes = [pad(input.edit.box), ...(input.edit.to ? [pad(input.edit.to)] : [])];
      mask = await maskOf(boxes, meta.width!, meta.height!);
      references = [small];
      ratio = input.ratio;
      prompt = editPrompt({ ratio, box: input.edit.box, to: input.edit.to, what: editWhat(stored, input.edit, input.words, layout), style: layout.style });
      paste = { original, boxes };
    } else {
      const t = templateOf(layout, d, input), people = t.people > 0 && hasCast, multi = input.skus.length > 1;
      references = [...await Promise.all(input.skus.map(s => output(multi ? `sku:${s}` : `product:${s}`))), ...(people ? [await output('cast')] : [])];
      ratio = input.ratio;
      const used = input.colors.map(n => colors.find(c => c.name === n)!).filter(Boolean);
      prompt = mainPrompt({ ratio, task: input.index >= 0 ? TASK_LABEL[d.slots[input.index].task as Task] : '长图', template: t, layout, content: contentOf(stored, input, job.slot),
        used, all: colors, garment, lead: d.model.lead, fromSku: multi, cast: people ? input.skus.length + 1 : null, n: input.ratio === 'long' ? undefined : input.n, total: input.total });
    }
    if (input.note) prompt += `\n\n补充要求：${input.note}`;
    const call = await generate({ prompt, references, ratio, mask }, {
      beforeSubmit: async () => {
        await db().query(`INSERT INTO listing_attempts(id,job_id,provider,model,status) VALUES($1,$2,'evolink',$3,'submitted')`, [attemptId, job.id, LISTING_IMAGE_MODEL]);
        submitted = true;
      },
      receipt: async id => { await db().query('UPDATE listing_attempts SET provider_request_id=$2 WHERE id=$1', [attemptId, id]); },
    });
    let bytes = call.bytes, upscaled: 'mediakit' | 'plain' | 'none' | 'pasted' | undefined;
    if (paste) { bytes = await pasteBack(paste.original, call.bytes, paste.boxes); upscaled = 'pasted'; }
    else if (input.kind === 'main') {
      // Main images go out at the platforms' sizes; the paid 1K image is kept if that fails.
      try { const up = await upscale(call.bytes, input.ratio); bytes = up.bytes; upscaled = up.enhanced ? 'mediakit' : 'plain'; } catch (error) {
        upscaled = 'none';
        console.error('[listing] upscale', error instanceof Error ? error.message : error);
      }
    }
    await db().query(`UPDATE listing_attempts SET status='succeeded',receipt=$2,finished_at=now() WHERE id=$1`, [attemptId, { taskId: call.taskId, credits: call.credits, durationMs: call.durationMs, upscaled }]);
    const asset = await storeOutput(job.tenant_id, job.project_id, job.slot, job.id, bytes);
    await db().query(`UPDATE listing_jobs SET status='succeeded',result_asset=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, asset]);
    if (input.kind === 'main') {
      // A square image changed on the 画板 is what its 3:4 image is written from.
      if (input.edit && input.ratio === 'square' && input.index >= 0 && !job.slot.includes('+')) await keepWords(job.project_id, input.index, input.words);
      await findElements(asset, bytes, templateOf(layout, d, input), input.words, recognize);
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : '出图失败').slice(0, 300);
    const notCharged = !!(error as { notCharged?: boolean }).notCharged;
    if (submitted) await db().query(`UPDATE listing_attempts SET status=CASE WHEN status='succeeded' THEN status WHEN $2 THEN 'failed' ELSE 'unknown' END,finished_at=now() WHERE id=$1`, [attemptId, notCharged]);
    const status = submitted && !notCharged ? 'unknown' : 'failed';
    await db().query(`UPDATE listing_jobs SET status=$2,error=$3,lease_until=NULL,updated_at=now() WHERE id=$1 AND status IN ('queued','running')`,
      [job.id, status, status === 'unknown' ? `${message}。可能已产生费用，由管理员核对` : `${message}。这张没扣费，可以重做`]);
  } finally {
    await finishRun(job.run_id, job.tenant_id, job.project_id);
  }
}

/** The square image's words after a 画板 change go into the plan (the 3:4 image follows them). */
async function keepWords(projectId: string, index: number, w: Words) {
  await catalogTransaction(async c => {
    const p = (await c.query('SELECT plan FROM listing_projects WHERE id=$1 FOR UPDATE', [projectId])).rows[0];
    const stored = p?.plan as StoredPlan | undefined;
    if (!stored?.draft.slots[index]) return;
    const slots = stored.draft.slots.map((s, i) => i === index ? { ...s, title: w.title, sub: w.sub, tags: w.tags, cells: w.cells.map(c => ({ point: c.point!, proof: c.proof })) } : s);
    await c.query('UPDATE listing_projects SET plan=$2 WHERE id=$1', [projectId, { ...stored, draft: { ...stored.draft, slots } }]);
  });
}

/** Where things are on a made image; a failure only leaves the 画板 on the layout's boxes. */
async function findElements(assetId: string, bytes: Buffer, t: Template, w: Words, recognize: Recognize) {
  try {
    const expected = expectedOf(t, w);
    const image = await sharp(bytes).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
    const call = await recognize(recognizeRequest({ image, expected, model: LISTING_PLAN_MODEL() }));
    const elements: Element[] = parseRecognized(call.content, expected);
    if (elements.length) await db().query('UPDATE listing_assets SET elements=$2::text::jsonb WHERE id=$1', [assetId, JSON.stringify(elements)]);
  } catch (error) { console.error('[listing] recognize', error instanceof Error ? error.message : error); }
}

/** A job whose prerequisite failed is not made, and costs nothing. */
export async function failBlocked(job: { id: string; run_id: string; tenant_id: string; project_id: string }, reason: string) {
  await db().query(`UPDATE listing_jobs SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='queued'`, [job.id, `${reason}，这张没做，没扣费`]);
  await finishRun(job.run_id, job.tenant_id, job.project_id);
}

/** When the last job of a run is done: settle what was sent, return the rest; the product waits for 「出竖版」 or is done. */
export async function finishRun(runId: string, tenantId: string, projectId: string) {
  const open = (await db().query(`SELECT 1 FROM listing_jobs WHERE run_id=$1 AND status IN ('queued','running') LIMIT 1`, [runId])).rowCount;
  if (open) return;
  const attempts = (await db().query(`SELECT a.id,a.status,j.input FROM listing_attempts a JOIN listing_jobs j ON j.id=a.job_id WHERE j.run_id=$1`, [runId])).rows as { id: string; status: string; input: JobInput }[];
  const outcomes: AttemptOutcome[] = attempts.map(a => ({ action: action(a.input), billable: a.status !== 'failed', certain: a.status === 'succeeded', attemptId: a.id }));
  await settleHold(runHold(runId), tenantId, outcomes).catch(error => console.error('[listing] settle', error instanceof Error ? error.message : error));
  if (!(await db().query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1`, [projectId])).rowCount) {
    await db().query(`UPDATE listing_projects SET status=CASE WHEN COALESCE((plan->>'round')::int,1)=2 THEN 'done' ELSE 'square' END, updated_at=now() WHERE id=$1 AND status='generating'`, [projectId]);
  }
}

/**
 * Per slot: the newest job's state, the current image and every version (oldest first) with the
 * words it was made with, what changed and where things are on it, for the page.
 */
export async function slotStates(projectId: string) {
  const p = (await db().query('SELECT plan FROM listing_projects WHERE id=$1', [projectId])).rows[0];
  const d = (p?.plan as StoredPlan | null)?.draft;
  const jobs = (await db().query(`SELECT DISTINCT ON (slot) slot,status,error,input FROM listing_jobs WHERE project_id=$1 AND slot IS NOT NULL ORDER BY slot, created_at DESC`, [projectId])).rows as { slot: string; status: string; error: string | null; input: JobInput }[];
  const outputs = await latestOutputs(projectId);
  const made = (await db().query(`SELECT a.id,a.slot,a.elements,j.input FROM listing_assets a LEFT JOIN listing_jobs j ON j.id=a.job_id WHERE a.project_id=$1 AND a.slot IS NOT NULL ORDER BY a.created_at`, [projectId])).rows as { id: string; slot: string; elements: Element[] | null; input: JobInput | null }[];
  const wordsOfInput = (input: JobInput | null) => input?.kind === 'main' ? input.words : null;
  return jobs.map(j => {
    const history = made.filter(v => v.slot === j.slot).map(v => ({ id: v.id, words: wordsOfInput(v.input), ...(v.input?.kind === 'main' && v.input.edit ? { change: v.input.edit.change } : {}), ...(v.elements ? { elements: v.elements } : {}) }));
    const image = outputs.get(j.slot)?.id ?? null;
    const task = j.input.kind === 'main' && j.input.index >= 0 ? d?.slots[j.input.index]?.task : undefined;
    return { slot: j.slot, status: j.status, error: j.error, image, history, words: history.find(v => v.id === image)?.words ?? wordsOfInput(j.input), ...(task ? { task } : {}), ...(j.input.kind === 'main' ? { colors: j.input.colors } : {}) };
  });
}

const KIND_FILE: Record<string, string> = { square: '1比1主图', portrait: '3比4主图', long: '2比3长图' };
/** Current images named in Taobao order; product images and each extra colour's covers in their own folder. */
export async function downloadZip(projectId: string) {
  const p = (await db().query('SELECT name,plan FROM listing_projects WHERE id=$1', [projectId])).rows[0];
  const stored = p.plan as StoredPlan | null, colors = stored?.colors ?? [], nameOf = (sku: string) => colors.find(c => c.sku === sku)?.name ?? sku;
  const states = await slotStates(projectId), outputs = await latestOutputs(projectId), zip = new JSZip();
  for (const s of states) {
    const o = outputs.get(s.slot); if (!o) continue;
    const [kind, key] = s.slot.split(':'), [n, set] = (key ?? '').split('+');
    const ext = o.name.split('.').pop() === 'jpeg' ? 'jpg' : 'png';
    const task = s.task ? TASK_LABEL[s.task as Task] : '';
    const main = kind === 'long' ? `${KIND_FILE.long}.${ext}` : `${KIND_FILE[kind]}-${n.padStart(2, '0')}-${task}.${ext}`;
    const name = kind === 'product' ? `白底产品图/${nameOf(key)}.${ext}` : kind === 'sku' ? `SKU-${nameOf(key)}.${ext}` : kind === 'cast' ? `模特定妆照.${ext}` : set ? `换色首图-${nameOf(set)}/${main}` : main;
    zip.file(name, await fileOf(o.file_id));
  }
  if (!Object.keys(zip.files).length) throw new CatalogHttpError(409, '还没有出好的图');
  return { name: `${p.name}-电商主图.zip`, bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) };
}
