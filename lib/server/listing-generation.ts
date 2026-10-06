/**
 * 电商主图 stage 2: turn the written plan into image jobs, run them in dependency order and settle
 * each run's credits once all of its jobs have finished.
 *
 *   product:<sku>  white-background product image of one colour (from its garment image)
 *   sku:<sku>      SKU image; colours after the main one copy the main colour's SKU image
 *   square:<n> / portrait:<n> / poster:1   main images; multi-colour ones use the colours' SKU images
 *   square:1+<sku> / portrait:1+<sku> / poster:1+<sku>   the covers of an extra set in that colour
 */
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { z } from 'zod';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile } from './catalog-files';
import { currentPrices, holdCredits, microToCents, priceOf, settleHold, type AttemptOutcome, type PriceSnapshot } from './credits';
import { imagesOf } from '../listing/plan';
import { resolveLayout } from './listing-layouts';
import { mainPrompt, productPrompt, skuPrompt, textEditPrompt, type MainSlot } from './listing-prompts';
import { generateListingImage, LISTING_IMAGE_MODEL, type ImageCall } from './listing-provider';
import { latestOutputs, slotWordsSchema, storeOutput, type StoredPlan } from './listing-store';
import { upscaleListingImage } from './listing-upscale';
import type { Tenant } from './tenant-scope';

/**
 * `note` is the user's extra instruction on a redo. `edit` changes only the words of an existing
 * image (`base`, a listing asset), which is then the only reference. `layout`: an extra set's own.
 */
type Words = { title: string; subtitle: string; bullets: string[] };
export type JobInput = (
  | { kind: 'product'; sku: string; direct?: boolean }
  | { kind: 'sku'; sku: string; anchor?: string }
  | { kind: 'main'; slot: MainSlot; skus: string[]; layout?: string; edit?: { base: string; from: Words } }
) & { note?: string };
type PlannedJob = { slot: string; step: 'product' | 'image'; input: JobInput; depends: string[]; multi: boolean; free?: boolean };
const db = () => catalogDatabase();
export const runHold = (runId: string) => 'listing:run:' + runId;
const action = (input: JobInput) => input.kind === 'main' && input.skus.length > 1 && !input.edit ? 'listing_image_multi' as const : 'listing_image' as const;
const mainDepends = (skus: string[]) => skus.length > 1 ? skus.map(s => `sku:${s}`) : [`product:${skus[0]}`];

/** Every image of a written plan in the order it has to be made; `only` keeps one extra set (its colour's label). */
export function planJobs(stored: StoredPlan, only?: string): PlannedJob[] {
  if (!stored.colors.length) throw new CatalogHttpError(409, '没有颜色，出不了图');
  const main = stored.colors[0].sku, skuOf = new Map(stored.colors.map(c => [c.name, c.sku]));
  const items = imagesOf({ colors: stored.colors.map(c => ({ name: c.name, pick: c.sku })), main: stored.colors[0].name, words: stored.main, extra: stored.extra }, new Set(stored.direct));
  return items.filter(it => !only || it.slot.endsWith('+' + only)).map((it): PlannedJob => {
    if (it.kind === 'product') return { slot: it.slot, step: 'product', input: { kind: 'product', sku: it.sku, ...(it.free ? { direct: true } : {}) }, depends: [], multi: false, free: it.free };
    if (it.kind === 'sku') {
      const anchor = it.sku === main ? undefined : main;
      return { slot: it.slot, step: 'image', input: { kind: 'sku', sku: it.sku, anchor }, depends: [`product:${it.sku}`, ...(anchor ? [`sku:${anchor}`] : [])], multi: false };
    }
    const ratio = it.ratio!, w = stored.main[ratio][it.index!], skus = it.colors!.map(n => skuOf.get(n)!);
    const slot: MainSlot = { kind: ratio, n: it.index! + 1, total: stored.main[ratio].length, role: w.role, title: w.title, subtitle: w.subtitle, bullets: w.bullets, scene: w.scene, colors: it.colors! };
    return { slot: it.slot, step: 'image', input: { kind: 'main', slot, skus, ...(it.layout ? { layout: it.layout } : {}) }, depends: mainDepends(skus), multi: it.multi };
  });
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
  const runId = await holdRun(c, tenant, projectId, jobs, prices);
  await insertJobs(c, tenant.id, user, projectId, runId, jobs);
  return runId;
}

/** One more cover set (1:1, 3:4 and poster covers) in another colour; everything else is shared. */
export async function addSet(tenant: Tenant, user: string, projectId: string, input: unknown) {
  const b = z.object({ color: z.string().min(1), layout: z.string().default('') }).parse(input);
  if (b.layout && !(await resolveLayout(tenant.id, b.layout, { forNewProject: true }))) throw new CatalogHttpError(400, '没有这个版式');
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status,plan FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (!['done', 'generating'].includes(p.status) || !p.plan) throw new CatalogHttpError(409, '出过图之后才能再加一套');
    const stored = p.plan as StoredPlan, color = stored.colors.find(x => x.name === b.color);
    if (!color) throw new CatalogHttpError(400, '没有这个颜色');
    if (color === stored.colors[0] || stored.extra.some(e => e.color === b.color)) throw new CatalogHttpError(409, `「${b.color}」已经有首图了`);
    stored.extra.push({ color: b.color, layout: b.layout });
    const jobs = planJobs(stored, color.sku);
    await queueRun(c, tenant, user, projectId, jobs, prices);
    await c.query('UPDATE listing_projects SET plan=$2 WHERE id=$1', [projectId, stored]);
    return { status: 'generating', images: jobs.length };
  });
}

export type RedoChange = { mode?: 'redraw' | 'text'; words?: unknown; base?: string; colors?: unknown };
/**
 * Make one image again; earlier versions are kept. For a main image the user may give new words,
 * picture and colours (`redraw`), or new words only on the image they are looking at (`text`).
 */
export async function redoSlot(tenant: Tenant, user: string, projectId: string, slot: string, note: string, change: RedoChange = {}) {
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status,plan FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (!['done', 'generating'].includes(p.status)) throw new CatalogHttpError(409, '出过图之后才能单张重做');
    const last = (await c.query(`SELECT step,input,depends FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1`, [projectId, slot])).rows[0];
    if (!last) throw new CatalogHttpError(404, '没有这张图');
    if ((await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND slot=$2 AND status IN ('queued','running')`, [projectId, slot])).rowCount) {
      throw new CatalogHttpError(409, '这张图正在出，等它出完再重做');
    }
    let input = { ...last.input, note: note.trim().slice(0, 200) || undefined } as JobInput;
    let depends = last.depends as string[];
    if (input.kind === 'main') delete input.edit;
    if (change.colors !== undefined) {
      if (input.kind !== 'main') throw new CatalogHttpError(400, '只有主图和海报能换颜色');
      const stored = p.plan as StoredPlan, names = z.array(z.string()).min(1).max(4).parse(change.colors);
      const skus = names.map(n => stored.colors.find(x => x.name === n)?.sku ?? (() => { throw new CatalogHttpError(400, `没有这个颜色：${n}`); })());
      input = { ...input, skus, slot: { ...input.slot, colors: names } };
      depends = mainDepends(skus);
    }
    if (change.words !== undefined || change.mode === 'text') {
      if (input.kind !== 'main') throw new CatalogHttpError(400, '只有主图和海报能改内容');
      const words = slotWordsSchema.parse(change.words);
      if (change.mode === 'text' && change.colors === undefined) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(change.base ?? '')) throw new CatalogHttpError(404, '没有这个版本');
        const base = (await c.query(`SELECT a.id,j.input FROM listing_assets a LEFT JOIN listing_jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.project_id=$2 AND a.slot=$3`, [change.base, projectId, slot])).rows[0];
        if (!base?.input?.slot) throw new CatalogHttpError(404, '没有这个版本');
        const from = base.input.slot as MainSlot;
        // Only the words change; the picture is the base image's.
        input = { ...input, slot: { ...from, title: words.title, subtitle: words.subtitle, bullets: words.bullets }, edit: { base: base.id, from: { title: from.title, subtitle: from.subtitle, bullets: from.bullets } }, note: undefined };
      } else input = { ...input, slot: { ...input.slot, title: words.title, subtitle: words.subtitle, bullets: words.bullets, scene: words.scene ?? input.slot.scene } };
    }
    const free = (x: JobInput) => x.kind === 'product' && !!x.direct;
    const jobs: PlannedJob[] = [{ slot, step: last.step, input, depends, multi: action(input) === 'listing_image_multi', free: free(input) }];
    // Images that were skipped because this one (or one of them) was missing come along.
    const skipped = (await c.query(`SELECT DISTINCT ON (slot) slot,step,input,depends,status,error FROM listing_jobs
      WHERE project_id=$1 AND slot IS NOT NULL AND slot<>$2 ORDER BY slot, created_at DESC`, [projectId, slot])).rows
      .filter(j => j.status === 'failed' && String(j.error).startsWith('前一步')) as { slot: string; step: 'product' | 'image'; input: JobInput; depends: string[] }[];
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

type ImageJob = { id: string; tenant_id: string; project_id: string; run_id: string; slot: string; input: JobInput };
type Generate = (input: Parameters<typeof generateListingImage>[0], hooks: { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> }) => Promise<ImageCall>;
export type Upscale = typeof upscaleListingImage;

async function fileOf(fileId: string) { return (await readCatalogFile(fileId)).bytes; }

/** One image: gather the reference images it depends on, call the generator, keep the result. */
export async function executeImage(job: ImageJob, generate: Generate = (input, hooks) => generateListingImage(input, hooks), upscale: Upscale = upscaleListingImage) {
  const attemptId = randomUUID();
  let submitted = false;
  try {
    const p = (await db().query('SELECT layout,plan FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
    const stored = p.plan as StoredPlan, input = job.input;
    const layout = await resolveLayout(job.tenant_id, (input.kind === 'main' && input.layout) || p.layout);
    if (!layout) throw new Error('版式不存在');
    const colors = stored.colors, outputs = await latestOutputs(job.project_id), garment = stored.garment;
    const output = async (slot: string) => { const o = outputs.get(slot); if (!o) throw new Error(`缺少前一步的图：${slot}`); return fileOf(o.file_id); };
    const colorOf = (sku: string) => colors.find(c => c.sku === sku) ?? (() => { throw new Error(`颜色不存在：${sku}`); })();
    let prompt: string, references: Buffer[], ratio: 'square' | 'portrait' | 'poster' = 'square';
    if (input.kind === 'product' && input.direct) {
      // The colour's own clean still life, on a white square: no model call, nothing charged.
      const assetId = stored.images.find(i => i.label === input.sku)?.assetId;
      const source = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [assetId])).rows[0];
      if (!source) throw new Error('找不到这个颜色的衣服图（原始素材可能已在最后一次出图 30 天后清理）');
      const square = await sharp(await fileOf(source.file_id), { limitInputPixels: 60_000_000 }).rotate().flatten({ background: '#ffffff' })
        .resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
      const asset = await storeOutput(job.tenant_id, job.project_id, job.slot, job.id, square);
      await db().query(`UPDATE listing_jobs SET status='succeeded',result_asset=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, asset]);
      return;
    }
    if (input.kind === 'product') {
      const assetId = stored.images.find(i => i.label === input.sku)?.assetId;
      const source = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [assetId])).rows[0];
      if (!source) throw new Error('找不到这个颜色的衣服图（原始素材可能已在最后一次出图 30 天后清理）');
      prompt = productPrompt({ color: colorOf(input.sku).name, garment });
      references = [await fileOf(source.file_id)];
    } else if (input.kind === 'sku') {
      prompt = skuPrompt({ layout, color: colorOf(input.sku).name, anchor: input.anchor && colorOf(input.anchor).name, tag: stored.sku.tag, fabric: stored.sku.fabric, garment });
      references = [await output(`product:${input.sku}`), ...(input.anchor ? [await output(`sku:${input.anchor}`)] : [])];
    } else if (input.edit) {
      const base = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND project_id=$2', [input.edit.base, job.project_id])).rows[0];
      if (!base) throw new Error('找不到要改字的那一版图');
      prompt = textEditPrompt({ kind: input.slot.kind, from: input.edit.from, to: input.slot });
      references = [await fileOf(base.file_id)];
      ratio = input.slot.kind;
    } else {
      const multi = input.skus.length > 1;
      prompt = mainPrompt({ layout, slot: input.slot, used: input.skus.map(colorOf), all: colors, fromSku: multi, garment });
      references = await Promise.all(input.skus.map(s => output(multi ? `sku:${s}` : `product:${s}`)));
      ratio = input.slot.kind;
    }
    if (input.note) prompt += `\n\n补充要求：${input.note}`;
    const call = await generate({ prompt, references, ratio }, {
      beforeSubmit: async () => {
        await db().query(`INSERT INTO listing_attempts(id,job_id,provider,model,status) VALUES($1,$2,'evolink',$3,'submitted')`, [attemptId, job.id, LISTING_IMAGE_MODEL]);
        submitted = true;
      },
      receipt: async id => { await db().query('UPDATE listing_attempts SET provider_request_id=$2 WHERE id=$1', [attemptId, id]); },
    });
    // Main images and the poster go out at the platforms' sizes; the paid 1K image is kept if that fails.
    let bytes = call.bytes, upscaled: 'mediakit' | 'plain' | 'none' | undefined;
    if (input.kind === 'main') {
      try { const up = await upscale(call.bytes, input.slot.kind); bytes = up.bytes; upscaled = up.enhanced ? 'mediakit' : 'plain'; } catch (error) {
        upscaled = 'none';
        console.error('[listing] upscale', error instanceof Error ? error.message : error);
      }
    }
    await db().query(`UPDATE listing_attempts SET status='succeeded',receipt=$2,finished_at=now() WHERE id=$1`, [attemptId, { taskId: call.taskId, credits: call.credits, durationMs: call.durationMs, upscaled }]);
    const asset = await storeOutput(job.tenant_id, job.project_id, job.slot, job.id, bytes);
    await db().query(`UPDATE listing_jobs SET status='succeeded',result_asset=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, asset]);
  } catch (error) {
    const message = (error instanceof Error ? error.message : '出图失败').slice(0, 300);
    const notCharged = !!(error as { notCharged?: boolean }).notCharged;
    if (submitted) await db().query(`UPDATE listing_attempts SET status=CASE WHEN status='succeeded' THEN status WHEN $2 THEN 'failed' ELSE 'unknown' END,finished_at=now() WHERE id=$1`, [attemptId, notCharged]);
    const status = submitted && !notCharged ? 'unknown' : 'failed';
    await db().query(`UPDATE listing_jobs SET status=$2,error=$3,lease_until=NULL,updated_at=now() WHERE id=$1`,
      [job.id, status, status === 'unknown' ? `${message}。可能已产生费用，由管理员核对` : `${message}。这张没扣费，可以重做`]);
  } finally {
    await finishRun(job.run_id, job.tenant_id, job.project_id);
  }
}

/** A job whose prerequisite failed is not made, and costs nothing. */
export async function failBlocked(job: { id: string; run_id: string; tenant_id: string; project_id: string }, reason: string) {
  await db().query(`UPDATE listing_jobs SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='queued'`, [job.id, `${reason}，这张没做，没扣费`]);
  await finishRun(job.run_id, job.tenant_id, job.project_id);
}

/** When the last job of a run is done: settle what was sent, return the rest. */
export async function finishRun(runId: string, tenantId: string, projectId: string) {
  const open = (await db().query(`SELECT 1 FROM listing_jobs WHERE run_id=$1 AND status IN ('queued','running') LIMIT 1`, [runId])).rowCount;
  if (open) return;
  const attempts = (await db().query(`SELECT a.id,a.status,j.input FROM listing_attempts a JOIN listing_jobs j ON j.id=a.job_id WHERE j.run_id=$1`, [runId])).rows as { id: string; status: string; input: JobInput }[];
  const outcomes: AttemptOutcome[] = attempts.map(a => ({ action: action(a.input), billable: a.status !== 'failed', certain: a.status === 'succeeded', attemptId: a.id }));
  await settleHold(runHold(runId), tenantId, outcomes).catch(error => console.error('[listing] settle', error instanceof Error ? error.message : error));
  if (!(await db().query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1`, [projectId])).rowCount) {
    await db().query(`UPDATE listing_projects SET status='done', updated_at=now() WHERE id=$1 AND status='generating'`, [projectId]);
  }
}

/**
 * Per slot: the newest job's state, the current image and every version (oldest first) with the
 * words and picture it was made from, for the page.
 */
export async function slotStates(projectId: string) {
  const jobs = (await db().query(`SELECT DISTINCT ON (slot) slot,status,error,input FROM listing_jobs WHERE project_id=$1 AND slot IS NOT NULL ORDER BY slot, created_at DESC`, [projectId])).rows as { slot: string; status: string; error: string | null; input: JobInput }[];
  const outputs = await latestOutputs(projectId);
  const made = (await db().query(`SELECT a.id,a.slot,j.input FROM listing_assets a LEFT JOIN listing_jobs j ON j.id=a.job_id WHERE a.project_id=$1 AND a.slot IS NOT NULL ORDER BY a.created_at`, [projectId])).rows as { id: string; slot: string; input: JobInput | null }[];
  const wordsOf = (input: JobInput | null) => input?.kind === 'main' ? { title: input.slot.title, subtitle: input.slot.subtitle, bullets: input.slot.bullets, scene: input.slot.scene } : null;
  return jobs.map(j => {
    const history = made.filter(v => v.slot === j.slot).map(v => ({ id: v.id, words: wordsOf(v.input) }));
    const image = outputs.get(j.slot)?.id ?? null;
    return { slot: j.slot, status: j.status, error: j.error, input: j.input, image, versions: history.length, history, words: history.find(v => v.id === image)?.words ?? wordsOf(j.input) };
  });
}

const ROLE_FILE: Record<string, string> = { square: '1比1主图', portrait: '3比4主图', poster: '2比3海报' };
/** Current images named in Taobao order; product images and each extra colour's covers in their own folder. */
export async function downloadZip(projectId: string) {
  const p = (await db().query('SELECT name,plan FROM listing_projects WHERE id=$1', [projectId])).rows[0];
  const colors = (p.plan as StoredPlan | null)?.colors ?? [], nameOf = (sku: string) => colors.find(c => c.sku === sku)?.name ?? sku;
  const states = await slotStates(projectId), outputs = await latestOutputs(projectId), zip = new JSZip();
  for (const s of states) {
    const o = outputs.get(s.slot); if (!o) continue;
    const [kind, key] = s.slot.split(':'), [n, set] = key.split('+');
    const ext = o.name.split('.').pop() === 'jpeg' ? 'jpg' : 'png';
    const main = kind === 'poster' ? `${ROLE_FILE.poster}.${ext}` : `${ROLE_FILE[kind]}-${n.padStart(2, '0')}-${s.input.kind === 'main' ? s.input.slot.role : ''}.${ext}`;
    const name = kind === 'product' ? `白底产品图/${nameOf(key)}.${ext}` : kind === 'sku' ? `SKU-${nameOf(key)}.${ext}` : set ? `换色首图-${nameOf(set)}/${main}` : main;
    zip.file(name, await fileOf(o.file_id));
  }
  if (!Object.keys(zip.files).length) throw new CatalogHttpError(409, '还没有出好的图');
  return { name: `${p.name}-电商主图.zip`, bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) };
}
