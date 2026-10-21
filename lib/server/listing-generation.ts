/**
 * 电商主图 generation: turn the written plan into image jobs in two rounds, run them in dependency
 * order and settle each run's credits once all of its jobs have finished.
 *
 *   product:<sku>  white-background product image of one colour (from its garment image)
 *   cast           the models every image with people is drawn from (one man, one woman)
 *   skumodel:<sku> the cast wearing a colour the material has no model photo of (for its SKU image): the
 *                  man and the woman when the cover has two people, else the lead
 *   sku:<sku>      SKU image; colours after the main one copy the main colour's SKU image
 *   square:<n>     round one: the square images; portrait:<n> and long:1 round two (「出竖版」)
 *   square:1+<sku> / portrait:1+<sku> / long:1+<sku>   the covers of an extra set in that colour
 *   service:<id>   on the shop's row (listing-shop): one of the shop's four service images
 *
 * The square image that shows the shop's services copies the shop's current one for the product's
 * master (free); its 3:4 image lays that one out again. 「点图修改」 redraws one image from its
 * current version as the user asked; the result is a candidate version until adopted.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { z } from 'zod';
import type { CanvasEdit, Element, Words } from '../listing/api-types';
import { TASK_LABEL, type Task } from '../listing/category';
import { castFromPhotos, GENDERS, leadCard, partOf, partPick, usedSlots, wantsCast, type Gender, type SkuPeople } from '../listing/draft';
import { colorRow, modelPhotoFor, skuCardText, skuPhotos, skuWho } from '../listing/sku-card';
import { renderSkuCard } from './listing-sku-card';
import { enOf, sampleBytes, specFor, specPrompt, type Fill } from './listing-specs';
import { removeFlatArtworkBackground } from './artwork-image-processing';
import { coverScene, fabricColor, masterInfo, PLACES, REAL_PLACE, SELLS, type PlaceId, type Sell } from '../listing/scene';
import { SERVICE_IMAGES, type ServiceImageId } from '../listing/service';
import type { SubmittedDraft } from '../listing/draft-schema';
import { proofById, recipeOf } from '../listing/proofs';
import { cellZones, fitTemplate, skuPair, type Box, type Layout, type Template } from '../listing/templates';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile } from './catalog-files';
import { currentPrices, holdCredits, microToCents, priceOf, settleHold, type AttemptOutcome, type PriceSnapshot } from './credits';
import { maskOf, pad, pasteBack } from './listing-edit';
import { resolveLayout } from './listing-layouts';
import { castOnePrompt, castPrompt, editPrompt, longPrompt, mainPrompt, productPrompt, redrawPrompt, relayoutPrompt, servicePrompt, serviceWordsPrompt, skuModelPrompt, skuPrompt, type Content, type Ratio } from './listing-prompts';
import { callPlanModel, generateListingImage, LISTING_PLAN_MODEL, listingImageModel, listingImageProvider, type ImageCall, type PlanCall } from './listing-provider';
import { frameRequest, parseFrame, parseRecognized, recognizeRequest, type Expected, type Frame } from './listing-recognize';
import { shopBrand, shopServiceImage, shopSettings } from './listing-shop';
import { cornerAssets, pasteShopLogo } from './listing-corner';
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
  /** The cast; drawn from the material's photos it is one person per image (`who`, from `photo` or made up), then `pair` puts the two side by side (free). */
  | { kind: 'cast'; who?: Gender; photo?: string; pair?: boolean }
  /** A colour's SKU image; `card`: put together by the program on the brand template (free), else drawn by the model. */
  | { kind: 'sku'; sku: string; anchor?: string; card?: boolean }
  /** The cast wearing a colour, for that colour's SKU image on the template: both (`pair`) or the lead. */
  | { kind: 'skuModel'; sku: string; pair?: boolean; who?: Gender }
  | { kind: 'main'; ratio: Ratio; index: number; n: number; total: number; skus: string[]; colors: string[]; words: Words; layout?: string; edit?: EditInput }
  /** One of the shop's service images, its words in `words.tags`; `stale`: only the words that changed since `from` are redrawn on `base`. */
  | { kind: 'service'; image: ServiceImageId; words: Words; stale?: { base: string; from: string[] } }
  /** A product's service image: the shop's current one for the master, copied (free). */
  | { kind: 'copy'; image: ServiceImageId; index: number; words: Words }
  /** A product's 3:4 service image: its square one (`from`) laid out again. */
  /**
   * A 3:4 image (or the 2:3 long image, from the square cover): its square one (`from`, the current version) laid out again;
   * `product`: the colour whose white image keeps the garment's details; `cast`: the cast comes too (the long image shows the face the cover crops).
   */
  | { kind: 'relayout'; from: string; ratio: Ratio; index: number; words: Words; product?: string; cast?: boolean }
  /** 「点图修改」: `base` (the current version) redrawn as asked; `reference`: the user's example image. */
  | { kind: 'redraw'; base: string; ask: string; reference?: string; ratio: Ratio; index?: number; words: Words | null }
) & { note?: string };
type PlannedJob = { slot: string; step: 'product' | 'image'; input: JobInput; depends: string[]; multi: boolean; free?: boolean };
const db = () => catalogDatabase();
export const runHold = (runId: string) => 'listing:run:' + runId;
const action = (input: JobInput) => input.kind === 'main' && input.skus.length > 1 && !input.edit ? 'listing_image_multi' as const : 'listing_image' as const;

/** Jobs without a model call: a colour's own still life, the shop's service image, the cast's two halves put together, a SKU image on the template. */
const freeJob = (x: JobInput) => (x.kind === 'product' && !!x.direct) || x.kind === 'copy' || (x.kind === 'cast' && !!x.pair) || (x.kind === 'sku' && !!x.card);

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
  const photos = stored.photos ?? {}, cast = wantsCast(d, layout, new Set(Object.keys(photos))), jobs: PlannedJob[] = [];
  // A drawn SKU model follows the cast's own halves when drawn from the material: one face per image to copy.
  const skuBy = skuWho(d, skuPair(layout)), pair = skuBy === '男女', halves = castFromPhotos(d.model);
  const castOf = halves ? (pair ? GENDERS.map(g => `cast:${g}`) : [`cast:${skuBy}`]) : ['cast'];
  /**
   * A 3:4 image from its square one. An image with people or the whole garment also gets the colour's
   * white image, for the garment's details; a close-up gets only the square image (a white image made
   * the model add a whole garment to it). Several colours: the square image has them all.
   * The 2:3 long image is the square cover laid out again the same way, so its words and type are the
   * cover's (10-13: written on its own, they came out unlike it); it shows the whole person, so the
   * cast comes too when the set has people (`people`: false for 无模特).
   */
  const relayoutJob = (slot: string, from: string, index: number, words: Words, colors: string[], l: Layout, ratio: Ratio = 'portrait', people = false): PlannedJob => {
    const whole = ratio === 'long' || l.templates[d.slots[index].task as Task].square.zones.some(z => z.kind === 'person' || z.kind === 'garment');
    const product = whole && colors.length === 1 ? skuOf.get(colors[0]) : undefined, face = ratio === 'long' && cast && people;
    return { slot, step: 'image', input: { kind: 'relayout', from, ratio, index, words, ...(product ? { product } : {}), ...(face ? { cast: true } : {}) },
      depends: [from, ...(product ? [`product:${product}`] : []), ...(face ? ['cast'] : [])], multi: false };
  };
  const mainJob = (slot: string, ratio: Ratio, index: number, n: number, total: number, chosen: string[], extraLayout?: string): PlannedJob => {
    const words = wordsOf(d, index), t = templateOf(layout, d, { ratio, index, words });
    // An image of fabric only, with no colour chosen for it, shows the colour that keeps the master's look.
    const colors = t.fabricOnly && index >= 0 && !d.slots[index].colors.length ? [fabricColor(d.layout, stored.colors)?.name ?? chosen[0]] : chosen;
    const skus = colors.map(c => skuOf.get(c)!).filter(Boolean);
    return { slot, step: 'image', input: { kind: 'main', ratio, index, n, total, skus, colors, words, ...(extraLayout ? { layout: extraLayout } : {}) }, depends: mainDepends(skus, cast && t.people > 0), multi: skus.length > 1 };
  };
  if (round === 1 && !only) {
    for (const c of stored.colors) jobs.push({ slot: `product:${c.sku}`, step: 'product', input: { kind: 'product', sku: c.sku, ...(stored.direct.includes(c.sku) ? { direct: true } : {}) }, depends: [], multi: false, free: stored.direct.includes(c.sku) });
    if (cast && castFromPhotos(d.model)) {
      for (const g of GENDERS) { const photo = d.model.photos?.[g]; jobs.push({ slot: `cast:${g}`, step: 'image', input: { kind: 'cast', who: g, ...(photo ? { photo } : {}) }, depends: [`product:${main}`], multi: false }); }
      jobs.push({ slot: 'cast', step: 'image', input: { kind: 'cast', pair: true }, depends: GENDERS.map(g => `cast:${g}`), multi: false, free: true });
    } else if (cast) jobs.push({ slot: 'cast', step: 'image', input: { kind: 'cast' }, depends: [`product:${main}`], multi: false });
    for (const c of stored.colors) {
      if (layout.sku.specCard) {
        // Every colour on a model: the material's own photo, else the cast drawn in it (the plan's choice of who).
        if (!photos[c.sku]) jobs.push({ slot: `skumodel:${c.sku}`, step: 'image', input: { kind: 'skuModel', sku: c.sku, ...(pair ? { pair } : skuBy === d.model.lead ? {} : { who: skuBy }) }, depends: [`product:${c.sku}`, ...castOf], multi: false });
        jobs.push({ slot: `sku:${c.sku}`, step: 'image', input: { kind: 'sku', sku: c.sku, card: true }, depends: [`product:${c.sku}`, ...(photos[c.sku] ? [] : [`skumodel:${c.sku}`])], multi: false, free: true });
        continue;
      }
      const anchor = c.sku === main ? undefined : main;
      jobs.push({ slot: `sku:${c.sku}`, step: 'image', input: { kind: 'sku', sku: c.sku, anchor }, depends: [`product:${c.sku}`, ...(cast && layout.sku.people ? ['cast'] : []), ...(anchor ? [`sku:${anchor}`] : [])], multi: false });
    }
  }
  const ratios: Ratio[] = round === 1 ? ['square'] : ['portrait'];
  for (const ratio of ratios) {
    const n = ratio === 'square' ? d.counts.square : Math.min(d.counts.portrait, d.counts.square), used = usedSlots(d, n);
    const squares = usedSlots(d, d.counts.square), service = masterInfo(d.layout).service;
    if (!only) used.forEach((i, k) => {
      const slot = `${ratio}:${k + 1}`, words = wordsOf(d, i), colors = d.slots[i].colors.length ? d.slots[i].colors : [d.main];
      // Every 3:4 image is its square one laid out again: the master's look and the user's adopted changes come along.
      if (ratio === 'portrait') { jobs.push(relayoutJob(slot, `square:${squares.indexOf(i) + 1}`, i, words, d.slots[i].shopService ? [] : colors, layout)); return; }
      if (!d.slots[i].shopService) { jobs.push(mainJob(slot, ratio, i, k + 1, used.length, colors)); return; }
      // The shop's service image: the square one is copied for free.
      jobs.push({ slot, step: 'image', input: { kind: 'copy', image: service, index: i, words }, depends: [], multi: false, free: true });
    });
    for (const e of d.extra) if (n && (!only || skuOf.get(e.color) === only)) {
      const sku = skuOf.get(e.color);
      jobs.push(ratio === 'portrait' ? relayoutJob(`portrait:1+${sku}`, `square:1+${sku}`, 0, wordsOf(d, 0), [e.color], layout) : mainJob(`${ratio}:1+${sku}`, ratio, 0, 1, used.length, [e.color], e.layout || undefined));
    }
  }
  if (round === 2 && d.counts.long) {
    // From the square cover when there is one; with no square images it is written on its own.
    const fromCover = d.counts.square > 0;
    if (!only) jobs.push(fromCover ? relayoutJob('long:1', 'square:1', 0, wordsOf(d, 0), [d.main], layout, 'long', layout.long.people > 0) : mainJob('long:1', 'long', -1, 1, 1, [d.main]));
    for (const e of d.extra) if (!only || skuOf.get(e.color) === only) {
      const sku = skuOf.get(e.color);
      jobs.push(fromCover ? relayoutJob(`long:1+${sku}`, `square:1+${sku}`, 0, wordsOf(d, 0), [e.color], layout, 'long', true) : mainJob(`long:1+${sku}`, 'long', -1, 1, 1, [e.color], e.layout || undefined));
    }
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
  return (await c.query(`SELECT DISTINCT ON (slot) slot,step,input,depends,status,error FROM listing_jobs WHERE project_id=$1 AND slot IS NOT NULL AND input->>'kind' <> 'redraw' ORDER BY slot, created_at DESC`, [projectId])).rows as
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
    // Everything drawn from the cast, and the free images put together from those (a SKU image from its model).
    for (let grew = true; grew;) {
      grew = false;
      for (const j of latest) {
        if (jobs.some(q => q.slot === j.slot)) continue;
        const follows = (freeJob(j.input) || j.input.kind === 'relayout') && j.depends.some(d => jobs.some(q => q.slot === d));
        if (!j.slot.startsWith('cast') && !j.depends.some(d => d.startsWith('cast')) && !follows) continue;
        const input = j.input.kind === 'main' ? { ...j.input, edit: undefined, note: undefined } : j.input;
        jobs.push({ slot: j.slot, step: j.step, input, depends: j.depends, multi: action(input) === 'listing_image_multi', free: freeJob(input) }); grew = true;
      }
    }
    const first = (slot: string) => ['cast', 'skumodel', 'sku'].findIndex(k => slot.startsWith(k)) + 1 || 9;
    jobs.sort((a, b) => first(a.slot) - first(b.slot));
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

/**
 * 「SKU 图全部重做」, or one colour's (`only`): the SKU images again by the current rules. Each
 * colour's own model photo is looked for again, the other colours' models are drawn from the cast
 * (paid; the cast too when the product has none yet) and every card is put together again (free).
 * Products made before the models were drawn get them this way.
 */
export async function redoSkus(tenant: Tenant, user: string, projectId: string, only?: string, people?: SkuPeople) {
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const { stored, layout } = await lockProject(c, tenant, projectId, ['square', 'done', 'generating'], '出过图之后才能重新生成 SKU 图');
    if (!layout.sku.specCard) throw new CatalogHttpError(409, '这个版式的 SKU 图不是按模板拼的，请单张重新生成');
    const latest = await latestJobs(c, projectId), busy = (j: { status: string }) => j.status === 'queued' || j.status === 'running';
    if (latest.some(j => (j.slot.startsWith('sku') || j.slot.startsWith('cast')) && busy(j))) throw new CatalogHttpError(409, 'SKU 图或定妆照还在出，等出完再重新生成');
    const m = (await c.query('SELECT materials FROM listing_projects WHERE id=$1', [projectId])).rows[0].materials;
    // 「SKU 图全部重新生成」 can change who the SKU images show (10-21).
    const draft = people ? { ...stored.draft, skuPeople: people } : stored.draft;
    const next: StoredPlan = { ...stored, draft, photos: skuPhotos(draft, m?.sorted?.images ?? [], skuPair(layout)) };
    const planned = planJobs(next, layout, 1), mine = (slot: string) => !only || slot.endsWith(`:${only}`);
    const jobs = planned.filter(j => (j.slot.startsWith('skumodel:') || j.slot.startsWith('sku:')) && mine(j.slot));
    // A product whose master had no people has no cast yet: it is made first.
    const made = new Set(latest.filter(j => j.status === 'succeeded').map(j => j.slot));
    if (jobs.some(j => j.depends.some(d => d.startsWith('cast') && !made.has(d)))) jobs.unshift(...planned.filter(j => j.slot.startsWith('cast')));
    await queueRun(c, tenant, user, projectId, jobs, prices);
    await c.query('UPDATE listing_projects SET plan=$2 WHERE id=$1', [projectId, next]);
    return { status: 'generating', images: jobs.length };
  });
}

/** Make one image again from what it was made with (a 画板 change is not repeated); earlier versions stay. */
export async function redoSlot(tenant: Tenant, user: string, projectId: string, slot: string, note: string) {
  // A SKU image on the template is made again by the current rules, its model with it.
  if (/^sku:/.test(slot)) {
    const last = (await db().query(`SELECT input FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1`, [projectId, slot])).rows[0];
    if (last?.input?.card) return redoSkus(tenant, user, projectId, slot.slice(4));
  }
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    await lockProject(c, tenant, projectId, ['square', 'done', 'generating'], '出过图之后才能单张重新生成');
    const latest = await latestJobs(c, projectId), last = latest.find(j => j.slot === slot);
    if (!last) throw new CatalogHttpError(404, '没有这张图');
    if (last.status === 'queued' || last.status === 'running') throw new CatalogHttpError(409, '这张图正在出，等它出完再重新生成');
    const input = { ...last.input, ...(last.input.kind === 'main' ? { edit: undefined } : {}), note: note.trim().slice(0, 200) || undefined } as JobInput;
    const jobs: PlannedJob[] = [{ slot, step: last.step, input, depends: last.depends, multi: action(input) === 'listing_image_multi', free: freeJob(input) }];
    // Images that were skipped because this one (or one of them) was missing come along, and the free ones put together from it.
    const skipped = latest.filter(j => j.slot !== slot && ((j.status === 'failed' && String(j.error).startsWith('前一步')) || freeJob(j.input)));
    for (let grew = true; grew;) {
      grew = false;
      for (const j of skipped) if (!jobs.some(q => q.slot === j.slot) && j.depends.some(d => jobs.some(q => q.slot === d))) {
        jobs.push({ slot: j.slot, step: j.step, input: j.input, depends: j.depends, multi: action(j.input) === 'listing_image_multi', free: freeJob(j.input) }); grew = true;
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

const redrawSchema = z.object({ slot: z.string().regex(MAIN_SLOT), ask: z.string().trim().min(1, '先写一句想怎么改').max(300, '要求最多 300 个字'), reference: z.uuid().optional() });
/**
 * 「点图修改」: the image's current version is redrawn as the user asks (with their reference image,
 * if any) at the price of one image. The result is kept as a candidate: 「采用」 makes it current.
 */
export async function redrawSlot(tenant: Tenant, user: string, projectId: string, body: unknown) {
  const parsed = redrawSchema.safeParse(body);
  if (!parsed.success) throw new CatalogHttpError(400, parsed.error.issues[0]?.message ?? '这次修改的内容不完整');
  const b = parsed.data;
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (!['square', 'done', 'generating'].includes(p.status)) throw new CatalogHttpError(409, '出过图之后才能改');
    const base = (await latestOutputs(projectId)).get(b.slot);
    if (!base) throw new CatalogHttpError(409, '这张还没出好');
    if ((await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND slot=$2 AND status IN ('queued','running') LIMIT 1`, [projectId, b.slot])).rowCount) throw new CatalogHttpError(409, '这张正在出，等它出完再改');
    if (b.reference && !(await c.query(`SELECT 1 FROM listing_assets WHERE id=$1 AND project_id=$2 AND kind='ref'`, [b.reference, projectId])).rowCount) throw new CatalogHttpError(400, '参考图不存在');
    const made = (await c.query(`SELECT j.input FROM listing_assets a LEFT JOIN listing_jobs j ON j.id=a.job_id WHERE a.id=$1`, [base.id])).rows[0]?.input as JobInput | undefined;
    const ratio: Ratio = b.slot.startsWith('portrait') ? 'portrait' : b.slot.startsWith('long') ? 'long' : 'square';
    const index = made && 'index' in made ? made.index : undefined, words = made && 'words' in made ? made.words : null;
    const input: JobInput = { kind: 'redraw', base: base.id, ask: b.ask, ...(b.reference ? { reference: b.reference } : {}), ratio, ...(index !== undefined ? { index } : {}), words };
    const id = randomUUID();
    const runId = await holdRun(c, tenant, projectId, [{ multi: false }], prices);
    await c.query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step,run_id,slot,input,depends,created_at) VALUES($1,$2,$3,$4,'image',$5,$6,$7,'{}',clock_timestamp())`,
      [id, tenant.id, projectId, user, runId, b.slot, input]);
    return { job: id };
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
/** At most this many photos of parts go with one main image: one per card (10-18: with three, a four-card image's last card had none and the model made its buckle up). */
const PART_PHOTOS = 4;
/**
 * The material's own photos of the parts a main image's cards show close up, after its other
 * references; each card says which one it is drawn from. Drawn from the white-background image alone,
 * next to the master's sample, close-ups took the sample's structure (10-15: wadding in a thin shell,
 * outer stitching for taped seams). A photo no longer kept (sources are cleared 30 days after the last
 * generation) leaves its card as it was.
 */
async function withPartPhotos(stored: StoredPlan, projectId: string, cells: Content['cells'], references: Buffer[]) {
  const at = new Map<string, number>();
  for (const cell of cells) {
    if (!cell.photo) continue;
    if (!at.has(cell.photo)) {
      const assetId = at.size < PART_PHOTOS ? stored.images.find(i => i.label === cell.photo)?.assetId : undefined;
      const row = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND project_id=$2', [assetId, projectId])).rows[0];
      const bytes = row ? await readCatalogFile(row.file_id).then(f => f.bytes, () => null) : null;
      if (!bytes) continue;
      at.set(cell.photo, references.push(await sharp(bytes, { limitInputPixels: 60_000_000 }).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer()));
    }
    cell.recipe += `（这个部位的样子照参考图${at.get(cell.photo)}：只取这个部位的结构、缝线和材质，参考图里的其他东西和字都不要）`;
  }
}
/** The cast's two halves side by side, man on the left, at one height: what every image with people is drawn from. */
async function sideBySide(halves: Buffer[]) {
  const parts = await Promise.all(halves.map(b => sharp(b).resize({ height: 1536 }).toBuffer({ resolveWithObject: true })));
  let left = 0;
  const placed = parts.map(p => { const at = { input: p.data, left, top: 0 }; left += p.info.width; return at; });
  return sharp({ create: { width: left, height: 1536, channels: 3, background: '#e6e6e6' } }).composite(placed).jpeg({ quality: 92 }).toBuffer();
}

/**
 * The cover's picture on a master shot on location: where it is worn and the point it acts out
 * (scene.ts); also the long image's, which keeps the cover's scene. Null elsewhere.
 */
export function coverOf(d: StoredPlan['draft'], layout: Layout) {
  const place = d.scene?.place as PlaceId | undefined, sell = d.scene?.sell as Sell | undefined;
  if (masterInfo(layout.id).cover !== '实景' || !place || !(place in PLACES) || !sell || !(sell in SELLS) || place in masterInfo(layout.id).deny) return null;
  return coverScene(place, sell, d.scene!, layout.id);
}
/** What a main image's zones show: words, each card's picture, the models' demonstration and the scene; `badge`: the words on the lanyard badge. */
export function contentOf(stored: StoredPlan, input: Extract<JobInput, { kind: 'main' }>, slot: string, layout: Layout, badge: string): Content {
  const d = stored.draft, s = input.index >= 0 ? d.slots[input.index] : undefined;
  // The card of the part the heading names is drawn first, the biggest picture.
  const lead = leadCard(d, input.words.title, input.words.cells), ordered = lead > 0 ? [input.words.cells[lead], ...input.words.cells.filter((_, k) => k !== lead)] : input.words.cells;
  const cells = ordered.map(c => {
    const p = d.points.find(x => x.id === c.point), proof = proofById(c.proof);
    // A close-up is drawn from the material's photo of that part; with none (a plan made before taped seams
    // wanted a photo of the tape) it is an icon and its words, never a structure the model makes up.
    const close = !!p && (!!proof?.part || proof?.kind === '部位特写'), photo = close ? partPick(d, partOf(p!)) : null;
    if (close && !photo && proof?.part) return { text: c.caption, recipe: `${proofById('icon-text')!.recipe}；底色干净，不画衣服、面料、胶条或任何结构`, icon: true, note: p?.note ?? '' };
    return { text: c.caption, recipe: proof ? recipeOf(proof, p && partOf(p)) : '', icon: proof?.kind === '图标文字' && proof.id === 'icon-text', note: p?.note ?? '', ...(photo ? { photo } : {}) };
  });
  let scene = stored.scenes[slot.split('+')[0]] ?? stored.scenes[`${input.ratio}:1`] ?? '';
  let act = s?.act ? proofById(s.act)?.recipe : undefined;
  const cover = (input.index === 0 || input.index < 0) ? coverOf(d, layout) : null;
  // The look carries its own light and weather: the writing step's light for the cover would fight it.
  if (cover) { scene = `${cover.bg}。这是场景实拍：画面要把「${d.scene!.sell}」这个卖点演出来，光线跟着场景和天气走；${REAL_PLACE}`; act = cover.person; }
  // The square and 3:4 covers frame the model the master's way; the long image shows the whole person.
  const crop = input.index === 0 ? masterInfo(layout.id).crop : undefined;
  if (crop) act = act ? `${act}；${crop}` : crop;
  return { title: input.words.title, sub: input.words.sub, tags: input.words.tags, cells, act, scene, badge };
}

type MainInput = Extract<JobInput, { kind: 'main' }>;
/**
 * A square main image drawn from its master's spec (listing-specs.ts): the garment (or a piece of its
 * fabric), the cast when people are in it, the customer's LOGO, and the master's sample image last.
 * Null when the master has no spec for the image, or the plan gave it another number of cards.
 */
export async function specShot(o: { stored: StoredPlan; projectId: string; input: MainInput; slot: string; layout: Layout; output: (slot: string) => Promise<Buffer>; cast: Buffer | null;
  logo: { bytes: Buffer | null; line: string } | null; badge: () => Promise<string>; corner?: boolean }) {
  const d = o.stored.draft, s = d.slots[o.input.index], task = s.task as Task;
  const spec = specFor(o.layout.id, task, o.input.words.cells.length);
  if (!spec || (spec.people && !o.cast)) return null;
  const colors = o.stored.colors, used = o.input.colors.map(n => colors.find(c => c.name === n)!).filter(Boolean);
  const references = spec.fabric ? [await fabricCrop(await o.output(`product:${o.input.skus[0]}`))] : await Promise.all(o.input.skus.map(x => o.output(`product:${x}`)));
  const cast = spec.people && o.cast ? references.push(o.cast) : undefined;
  const logo = !spec.fabric && o.logo?.bytes ? references.push(o.logo.bytes) : undefined;
  const sample = references.push(await sampleBytes(spec));
  // 免费印绣 on 车展工牌's lanyard badge and in 暗黑科技's black block, when the shop offers it.
  const c = contentOf(o.stored, o.input, o.slot, o.layout, task === '首图' && ['M1', 'M2'].includes(o.layout.id) ? await o.badge() : '');
  await withPartPhotos(o.stored, o.projectId, c.cells, references);
  const lead = d.model.lead === '男' ? '男生' : '女生', luma = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
  const fill: Fill = {
    title: c.title, sub: c.sub, tags: c.tags.filter(t => !t.includes('｜')),
    facts: c.tags.filter(t => t.includes('｜')).map(t => { const [label, word] = t.split('｜'); return { label, word }; }),
    cells: c.cells.map(x => ({ text: x.text, note: x.note ?? '', recipe: x.recipe, en: enOf(x.text) })),
    color: used[0]?.name ?? colors[0].name, colors: used, all: colors, light: luma(used[0]?.hex ?? '#ffffff') > 150,
    who: o.layout.templates.首图.square.people >= 2 && task === '首图' ? `参考图${cast}里的一男一女并排站，男生在左、身体朝右微侧，女生在右` : `参考图${cast}里的${lead}`,
    ...(task === '首图' ? { act: c.act, scene: c.scene || undefined } : {}), badge: c.badge ?? '',
    castRef: cast, place: o.stored.place,
  };
  const prompt = specPrompt({ master: o.layout.id, task, taskLabel: TASK_LABEL[task], n: o.input.n, total: o.input.total, spec, fill, garment: o.stored.garment,
    logo: spec.fabric ? null : o.logo?.line ?? null, refs: { garment: spec.fabric ? used.slice(0, 1) : used, cast, logo, sample }, corner: o.corner });
  return { prompt, references };
}

/** What is printed on the chest, from the plan's choice; the customer's LOGO comes as a reference image. */
// 10-21: 「小小的」 came out a few millimetres wide, hard to see; a real left-chest print is about a palm wide.
const CHEST_SIZE = '宽约 8–10 厘米，约占左半边前胸宽度的一半，整张图缩小了也能一眼看清';
const CHEST_IMAGE = `衣服胸口左侧印客户的 LOGO（照它的参考图），${CHEST_SIZE}，像真实印绣上去的`;
export const LOGO_LINE = { LOGO: `衣服胸口左侧印一个白色「LOGO」字样，${CHEST_SIZE}，像真实印绣上去的`, 样例: CHEST_IMAGE, 客户: CHEST_IMAGE } as const;
/** A piece of the garment's fabric, for images that show only fabric: the left chest of the product image, away from the zip and pockets. */
export async function fabricCrop(product: Buffer) {
  const { data, info } = await sharp(product).flatten({ background: '#ffffff' }).trim({ threshold: 12 }).png().toBuffer({ resolveWithObject: true });
  const side = Math.max(32, Math.round(info.width * 0.18));
  const left = Math.round(info.width * 0.25), top = Math.min(Math.round(info.height * 0.32), info.height - side);
  return sharp(data).extract({ left, top, width: Math.min(side, info.width - left), height: Math.min(side, info.height - top) }).resize(512, 512, { fit: 'cover' }).png().toBuffer();
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

/** The washed competitor sample each service image learns from, in the repository (lib is part of the worker image). */
const sampleOf = (sample: string) => readFile(join(process.cwd(), 'lib/listing/service-samples', `${sample}.jpg`));
/** A version of one of this product's images, at 1K, as a reference. */
async function versionAt1K(projectId: string, assetId: string) {
  const row = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND project_id=$2', [assetId, projectId])).rows[0];
  if (!row) throw new CatalogHttpError(404, '找不到要改的那一版图');
  return sharp(await fileOf(row.file_id)).resize(1024, 1024, { fit: 'inside' }).png().toBuffer();
}

/** One image: gather the reference images it depends on, call the generator, keep the result. */
export async function executeImage(job: ImageJob, generate: Generate = (input, hooks) => generateListingImage(input, hooks), upscale: Upscale = upscaleListingImage,
  recognize: Recognize = request => callPlanModel(request, { beforeSubmit: async () => {}, receipt: async () => {} })) {
  const attemptId = randomUUID();
  let submitted = false;
  try {
    const input = job.input;
    // Drawn with the top-left corner kept for the shop's LOGO (lib/listing/corner.ts): a square main image while
    // the shop shows its LOGO, and what is made from one that did (its 3:4 image, 点图修改, 画板). Kept on the receipt.
    let corner = false;
    const kept = async (asset: string | undefined) => !!asset && (await cornerAssets(job.tenant_id, [asset])).size > 0;
    const succeed = async (bytes: Buffer, candidate = false) => {
      const asset = await storeOutput(job.tenant_id, job.project_id, job.slot, job.id, bytes, candidate);
      await db().query(`UPDATE listing_jobs SET status='succeeded',result_asset=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, asset]);
      return asset;
    };
    if (input.kind === 'copy') {
      // The shop's service image for this master: copied, no model call, nothing charged.
      const bytes = await shopServiceImage(job.tenant_id, input.image);
      if (!bytes) throw new CatalogHttpError(409, '店铺还没出这套母版的服务图：去「店铺设置」确认生成后，再点重新生成');
      await succeed(bytes);
      return;
    }
    const p = (await db().query('SELECT plan FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
    const stored = p.plan as StoredPlan, d = stored?.draft;
    const layout = d ? await resolveLayout(job.tenant_id, (input.kind === 'main' && input.layout) || d.layout) : undefined;
    if (d && !layout) throw new CatalogHttpError(404, '版式不存在');
    const outputs = await latestOutputs(job.project_id);
    const output = async (slot: string) => { const o = outputs.get(slot); if (!o) throw new CatalogHttpError(409, `缺少前一步的图：${slot}`); return fileOf(o.file_id); };
    let prompt = '', references: Buffer[] = [], ratio: Ratio = 'square', mask: Buffer | undefined, paste: { original: Buffer; boxes: Box[] } | undefined;
    if (input.kind === 'service') {
      const def = SERVICE_IMAGES.find(x => x.id === input.image)!, words = input.words.tags;
      if (input.stale) {
        references = [await versionAt1K(job.project_id, input.stale.base)];
        prompt = serviceWordsPrompt(words.map((to, i) => ({ from: input.stale!.from[i] ?? '', to })).filter(x => x.from !== x.to && x.from));
      } else {
        const { logo } = def.kind === 'crafts' ? await shopSettings(job.tenant_id) : { logo: null };
        references = [await sampleOf(def.sample), ...(logo ? [logo] : [])];
        prompt = servicePrompt(def, words, !!logo);
      }
    } else if (input.kind === 'relayout') {
      references = [await output(input.from), ...(input.product ? [await output(`product:${input.product}`)] : []), ...(input.cast ? [await output('cast')] : [])];
      ratio = input.ratio;
      corner = input.ratio === 'portrait' && await kept(outputs.get(input.from)?.id);
      prompt = input.ratio === 'long' ? longPrompt({ garment: !!input.product, cast: input.cast ? references.length : null }) : relayoutPrompt(!!input.product, corner);
    } else if (input.kind === 'redraw') {
      references = [await versionAt1K(job.project_id, input.base)];
      if (input.reference) {
        const ref = (await db().query(`SELECT file_id FROM listing_assets WHERE id=$1 AND project_id=$2 AND kind='ref'`, [input.reference, job.project_id])).rows[0];
        if (!ref) throw new CatalogHttpError(404, '参考图找不到了');
        references.push(await fileOf(ref.file_id));
      }
      ratio = input.ratio;
      corner = await kept(input.base);
      prompt = redrawPrompt({ ratio, ask: input.ask, reference: !!input.reference, style: layout?.style, corner });
    } else {
      if (!d || !layout) throw new CatalogHttpError(409, '还没有定方案');
      const colors = stored.colors, garment = stored.garment, main = colors[0];
      const colorOf = (sku: string) => colors.find(c => c.sku === sku) ?? (() => { throw new CatalogHttpError(404, `颜色不存在：${sku}`); })();
      const hasCast = outputs.has('cast');
      // What is printed on the chest; a LOGO image (the shop's sample one, or this product's customer one) is sent as the last reference image.
      // The shop's sample LOGO deleted since the plan: the word 「LOGO」, as the shop page says.
      const sample = d.logo?.mode === '样例' ? (await shopSettings(job.tenant_id)).logo : null;
      const logoMode = d.logo?.mode === '样例' && !sample ? 'LOGO' : d.logo?.mode ?? 'LOGO', logoAsset = logoMode === '客户' ? stored.images.find(i => i.label === d.logo?.label)?.assetId : undefined;
      const logoBytes = sample ?? (logoAsset ? await fileOf((await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [logoAsset])).rows[0].file_id) : null);
      const logoLine = logoMode === '不印' || (logoMode !== 'LOGO' && !logoBytes) ? null : LOGO_LINE[logoMode];
      if (input.kind === 'sku' && input.card) {
        // The SKU image on the brand template: the colour's model photo (the material's own, else the drawn one), its fabric, the material's words. No model call.
        const m = (await db().query('SELECT name, materials FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
        const color = colorOf(input.sku), product = await output(`product:${input.sku}`);
        // Plans made before the SKU models were drawn: the material's photo found now, else the garment cut out.
        const label = stored.photos ? stored.photos[input.sku] : modelPhotoFor(m.materials?.sorted?.images ?? [], input.sku, color.name, d.model.lead, skuPair(layout));
        const assetId = label ? stored.images.find(i => i.label === label)?.assetId : undefined;
        const source = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [assetId])).rows[0];
        if (label && !source) throw new CatalogHttpError(404, '找不到这个颜色的模特图（原始素材可能已在最后一次出图 30 天后清理）');
        const photo = source ? await fileOf(source.file_id) : outputs.has(`skumodel:${input.sku}`) ? await output(`skumodel:${input.sku}`) : null;
        // A photo in a scene (the material's, or a SKU model drawn where the set is shot since 10-16): the
        // analysis model finds the model's head and knees on it. A drawn one on plain grey is measured instead.
        const frame = photo && (source || stored.place) ? await findFrame(photo, recognize) : null;
        const text = skuCardText({ name: m.name, category: d.category, points: d.points, color: color.name });
        await succeed(await renderSkuCard({
          // The shop's own LOGO while it shows one (店铺设置); the sample LOGO is only for the crafts image.
          ...text, rows: [...text.rows, colorRow(color.name)], logo: await (await shopBrand(job.tenant_id))?.bytes().catch(() => null) ?? null, fabric: await fabricCrop(product),
          photo: photo ? { bytes: photo, cutout: false, frame } : { bytes: await removeFlatArtworkBackground(product, { r: 255, g: 255, b: 255 }), cutout: true },
          // The material's own words (「男女同码」), else 「男女同款」 when it has model photos of both.
          tag: stored.sku?.tag?.includes('男女') ? stored.sku.tag : d.model.photos?.男 && d.model.photos?.女 ? '男女同款' : null,
        }));
        return;
      }
      if (input.kind === 'skuModel') {
        // The cast's own halves when drawn from the material (one face per image), else the cast of two.
        const who = input.who ?? d.model.lead, halves = input.pair ? GENDERS.every(g => outputs.has(`cast:${g}`)) : outputs.has(`cast:${who}`);
        const cast = halves ? (input.pair ? GENDERS.map(g => `cast:${g}`) : [`cast:${who}`]) : ['cast'];
        references = [await output(`product:${input.sku}`), ...await Promise.all(cast.map(output))];
        if (logoBytes && logoLine) references.push(logoBytes);
        prompt = skuModelPrompt({ color: colorOf(input.sku).name, garment, lead: who, who: input.pair ? 'pair' : 'lead', halves, logo: logoLine, logoRef: logoBytes && logoLine ? references.length : undefined,
          place: stored.place, pose: colors.findIndex(c => c.sku === input.sku) });
        ratio = 'portrait';
      } else if (input.kind === 'product') {
        const assetId = stored.images.find(i => i.label === input.sku)?.assetId;
        const source = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [assetId])).rows[0];
        if (!source) throw new CatalogHttpError(404, '找不到这个颜色的衣服图（原始素材可能已在最后一次出图 30 天后清理）');
        if (input.direct) {
          // The colour's own clean still life, on a white square: no model call, nothing charged.
          const square = await sharp(await fileOf(source.file_id), { limitInputPixels: 60_000_000 }).rotate().flatten({ background: '#ffffff' })
            .resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
          await succeed(square);
          return;
        }
        prompt = productPrompt({ color: colorOf(input.sku).name, garment, group: !!stored.sourceSelections?.[input.sku] });
        references = [await fileOf(source.file_id)];
      } else if (input.kind === 'cast' && input.pair) {
        await succeed(await sideBySide(await Promise.all(GENDERS.map(g => output(`cast:${g}`)))));
        return;
      } else if (input.kind === 'cast' && input.who) {
        const assetId = input.photo ? stored.images.find(i => i.label === input.photo)?.assetId : undefined;
        const source = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [assetId])).rows[0];
        if (input.photo && !source) throw new CatalogHttpError(404, '找不到选的模特照片（原始素材可能已在最后一次出图 30 天后清理）');
        const photo = source ? await sharp(await fileOf(source.file_id), { limitInputPixels: 60_000_000 }).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer() : null;
        prompt = castOnePrompt({ color: main.name, garment, who: input.who, photo: !!photo });
        references = [await output(`product:${main.sku}`), ...(photo ? [photo] : [])];
        ratio = 'portrait';
      } else if (input.kind === 'cast') {
        prompt = castPrompt({ color: main.name, garment });
        references = [await output(`product:${main.sku}`)];
        ratio = 'portrait';
      } else if (input.kind === 'sku') {
        const people = layout.sku.people > 0 && hasCast;
        references = [await output(`product:${input.sku}`), ...(people ? [await output('cast')] : []), ...(input.anchor ? [await output(`sku:${input.anchor}`)] : [])];
        if (logoBytes && logoLine) references.push(logoBytes);
        prompt = skuPrompt({ layout, color: colorOf(input.sku).name, tag: stored.sku.tag, fabric: stored.sku.fabric, garment, lead: d.model.lead,
          cast: people ? 2 : null, anchor: input.anchor ? (people ? 3 : 2) : null, anchorColor: input.anchor ? colorOf(input.anchor).name : undefined,
          logo: logoLine, logoRef: logoBytes && logoLine ? references.length : undefined });
      } else if (input.edit) {
        // A 画板 change: the current version at 1K is the reference; only the box is redrawn.
        const base = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND project_id=$2', [input.edit.base, job.project_id])).rows[0];
        if (!base) throw new CatalogHttpError(404, '找不到要改的那一版图');
        const original = await fileOf(base.file_id), small = await sharp(original).resize(1024, 1024, { fit: 'inside' }).png().toBuffer();
        corner = await kept(input.edit.base);
        const meta = await sharp(small).metadata(), boxes = [pad(input.edit.box), ...(input.edit.to ? [pad(input.edit.to)] : [])];
        mask = await maskOf(boxes, meta.width!, meta.height!);
        references = [small];
        ratio = input.ratio;
        prompt = editPrompt({ ratio, box: input.edit.box, to: input.edit.to, what: editWhat(stored, input.edit, input.words, layout), style: layout.style });
        paste = { original, boxes };
      } else if (input.ratio === 'square' && input.index >= 0) {
        corner = !!(await shopBrand(job.tenant_id));
        // A square image its master has a spec for: drawn the way the master's sample was.
        const shot = await specShot({ corner, stored, projectId: job.project_id, input, slot: job.slot, layout, output, cast: hasCast ? await output('cast') : null,
          logo: logoBytes && logoLine ? { bytes: logoBytes, line: logoLine } : logoLine ? { bytes: null, line: logoLine } : null,
          badge: async () => (await shopSettings(job.tenant_id)).settings?.items.some(x => x.on && x.title === '免费印绣') ? '免费印绣' : '' });
        if (shot) { references = shot.references; prompt = shot.prompt; ratio = 'square'; }
      }
      if (!prompt && input.kind === 'main' && !input.edit) {
        const t = templateOf(layout, d, input), people = t.people > 0 && hasCast, multi = input.skus.length > 1;
        // An image of fabric only gets a piece of the fabric: the whole garment made the model draw an extra one.
        const fabric = !!t.fabricOnly && !multi;
        const shows = t.zones.some(z => z.kind === 'person' || z.kind === 'garment');
        references = fabric ? [await fabricCrop(await output(`product:${input.skus[0]}`))]
          : await Promise.all(input.skus.map(s => output(multi ? `sku:${s}` : `product:${s}`)));
        if (people) references.push(await output('cast'));
        const cast = people ? references.length : null;
        if (shows && logoBytes && logoLine) references.push(logoBytes);
        ratio = input.ratio;
        const used = input.colors.map(n => colors.find(c => c.name === n)!).filter(Boolean);
        const shop = t.zones.some(z => z.kind === 'badge') ? (await shopSettings(job.tenant_id)).settings : null;
        const badge = shop?.items.some(x => x.on && x.title === '免费印绣') ? '免费印绣' : '';
        const logoRef = shows && logoBytes && logoLine ? references.length : undefined, content = contentOf(stored, input, job.slot, layout, badge);
        await withPartPhotos(stored, job.project_id, content.cells, references);
        prompt = mainPrompt({ ratio, task: input.index >= 0 ? TASK_LABEL[d.slots[input.index].task as Task] : '长图', template: t, layout, content,
          used, all: colors, garment, lead: d.model.lead, fromSku: multi, cast, n: input.ratio === 'long' ? undefined : input.n, total: input.total,
          logo: shows ? logoLine : null, logoRef, fabric, place: stored.place, corner });
      }
    }
    if (input.note) prompt += `\n\n补充要求：${input.note}`;
    const call = await generate({ prompt, references, ratio, mask }, {
      beforeSubmit: async () => {
        await db().query(`INSERT INTO listing_attempts(id,job_id,provider,model,status) VALUES($1,$2,$3,$4,'submitted')`, [attemptId, job.id, listingImageProvider(), listingImageModel()]);
        submitted = true;
      },
      receipt: async id => { await db().query('UPDATE listing_attempts SET provider_request_id=$2 WHERE id=$1', [attemptId, id]); },
    });
    let bytes = call.bytes, upscaled: 'mediakit' | 'plain' | 'none' | 'pasted' | undefined;
    const shaped = input.kind === 'main' || input.kind === 'service' || input.kind === 'relayout' || input.kind === 'redraw';
    if (paste) { bytes = await pasteBack(paste.original, call.bytes, paste.boxes); upscaled = 'pasted'; }
    else if (shaped) {
      // Main images go out at the platforms' sizes; the paid 1K image is kept if that fails.
      try { const up = await upscale(call.bytes, ratio); bytes = up.bytes; upscaled = up.enhanced ? 'mediakit' : 'plain'; } catch (error) {
        upscaled = 'none';
        console.error('[listing] upscale', error instanceof Error ? error.message : error);
      }
    }
    await db().query(`UPDATE listing_attempts SET status='succeeded',receipt=$2,finished_at=now() WHERE id=$1`, [attemptId, { taskId: call.taskId, credits: call.credits, durationMs: call.durationMs, upscaled, ...(corner ? { corner } : {}) }]);
    const asset = await succeed(bytes, input.kind === 'redraw');
    if (input.kind === 'main' && input.edit && d && layout) {
      // A square image changed on the 画板 is what its 3:4 image is written from.
      if (input.ratio === 'square' && input.index >= 0 && !job.slot.includes('+')) await keepWords(job.project_id, input.index, input.words);
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

/** Where the model is on a material photo; a failure only leaves the photo cropped to the panel. */
async function findFrame(bytes: Buffer, recognize: Recognize): Promise<Frame | null> {
  try {
    const image = await sharp(bytes, { limitInputPixels: 60_000_000 }).rotate().resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
    return parseFrame((await recognize(frameRequest({ image, model: LISTING_PLAN_MODEL() }))).content);
  } catch (error) { console.error('[listing] frame', error instanceof Error ? error.message : error); return null; }
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
 * words it was made with, what changed and where things are on it, for the page; `redraw`: the
 * newest 「点图修改」 on it, whose result is a version marked with its job until adopted.
 */
export async function slotStates(projectId: string) {
  const p = (await db().query('SELECT plan FROM listing_projects WHERE id=$1', [projectId])).rows[0];
  const d = (p?.plan as StoredPlan | null)?.draft;
  const jobs = (await db().query(`SELECT DISTINCT ON (slot) slot,status,error,input FROM listing_jobs WHERE project_id=$1 AND slot IS NOT NULL AND input->>'kind' <> 'redraw' ORDER BY slot, created_at DESC`, [projectId])).rows as { slot: string; status: string; error: string | null; input: JobInput }[];
  const redraws = new Map(((await db().query(`SELECT DISTINCT ON (slot) id,slot,status,error FROM listing_jobs WHERE project_id=$1 AND input->>'kind' = 'redraw' ORDER BY slot, created_at DESC`, [projectId])).rows as { id: string; slot: string; status: string; error: string | null }[])
    .map(r => [r.slot, { job: r.id, status: r.status === 'queued' || r.status === 'running' ? 'running' as const : r.status === 'succeeded' ? 'succeeded' as const : 'failed' as const, error: r.error }]));
  const outputs = await latestOutputs(projectId);
  const made = (await db().query(`SELECT a.id,a.slot,a.elements,a.job_id,j.input FROM listing_assets a LEFT JOIN listing_jobs j ON j.id=a.job_id WHERE a.project_id=$1 AND a.slot IS NOT NULL ORDER BY a.created_at`, [projectId])).rows as { id: string; slot: string; elements: Element[] | null; job_id: string | null; input: JobInput | null }[];
  const wordsOfInput = (input: JobInput | null) => input && 'words' in input ? input.words : null;
  const changeOf = (input: JobInput | null) => input?.kind === 'main' && input.edit ? input.edit.change : input?.kind === 'redraw' ? input.ask : undefined;
  return jobs.map(j => {
    const history = made.filter(v => v.slot === j.slot).map(v => {
      const change = changeOf(v.input);
      return { id: v.id, words: wordsOfInput(v.input), ...(change ? { change } : {}), ...(v.input?.kind === 'redraw' && v.job_id ? { job: v.job_id } : {}), ...(v.elements ? { elements: v.elements } : {}) };
    });
    const image = outputs.get(j.slot)?.id ?? null, index = 'index' in j.input ? j.input.index : undefined;
    const task = index !== undefined && index >= 0 ? d?.slots[index]?.task : undefined, redraw = redraws.get(j.slot);
    return { slot: j.slot, status: j.status, error: j.error, image, history, words: history.find(v => v.id === image)?.words ?? wordsOfInput(j.input), ...(task ? { task } : {}),
      ...(j.input.kind === 'main' ? { colors: j.input.colors } : {}), ...(redraw ? { redraw } : {}) };
  });
}

const KIND_FILE: Record<string, string> = { square: '1比1主图', portrait: '3比4主图', long: '2比3长图' };
// Colour names are typed by the user; inside the zip they stay one file name, never a path.
export const zipEntryName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').replace(/^\.+/u, '_') || '_';
/**
 * Current images named in Taobao order; product images and each extra colour's covers in their own folder.
 * The main images drawn with the corner kept get the shop's LOGO, as on the page (listing-corner.ts).
 */
export async function downloadZip(projectId: string) {
  const p = (await db().query('SELECT name,plan,tenant_id FROM listing_projects WHERE id=$1', [projectId])).rows[0];
  const stored = p.plan as StoredPlan | null, colors = stored?.colors ?? [], nameOf = (sku: string) => zipEntryName(colors.find(c => c.sku === sku)?.name ?? sku);
  const states = await slotStates(projectId), outputs = await latestOutputs(projectId), zip = new JSZip();
  const brand = await shopBrand(p.tenant_id), corner = brand ? await cornerAssets(p.tenant_id, [...outputs.values()].map(o => o.id)) : new Set<string>();
  const logo = corner.size ? await brand!.bytes().catch(() => null) : null;
  for (const s of states) {
    const o = outputs.get(s.slot); if (!o) continue;
    const [kind, key] = s.slot.split(':'), [n, set] = (key ?? '').split('+');
    if (kind === 'cast' && key) continue; // the two halves are in the cast
    const ext = o.name.split('.').pop() === 'jpeg' ? 'jpg' : 'png';
    const task = s.task ? TASK_LABEL[s.task as Task] : '';
    const main = kind === 'long' ? `${KIND_FILE.long}.${ext}` : `${KIND_FILE[kind]}-${n.padStart(2, '0')}-${task}.${ext}`;
    const name = kind === 'product' ? `白底产品图/${nameOf(key)}.${ext}` : kind === 'sku' ? `SKU-${nameOf(key)}.${ext}` : kind === 'skumodel' ? `SKU模特图/${nameOf(key)}.${ext}` : kind === 'cast' ? `模特定妆照.${ext}` : set ? `换色首图-${nameOf(set)}/${main}` : main;
    const bytes = await fileOf(o.file_id);
    zip.file(name, logo && corner.has(o.id) ? await pasteShopLogo(bytes, logo) : bytes);
  }
  if (!Object.keys(zip.files).length) throw new CatalogHttpError(409, '还没有出好的图');
  return { name: `${p.name}-电商主图.zip`, bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) };
}
