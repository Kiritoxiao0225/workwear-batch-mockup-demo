/**
 * 电商主图 stage 2: turn a confirmed plan into image jobs, run them in dependency order and settle
 * each run's credits once all of its jobs have finished.
 *
 *   product:<sku>  white-background product image of one colour (from its SKU image)
 *   sku:<sku>      SKU image; colours after the first copy the first colour's SKU image
 *   square:<n> / portrait:<n> / poster:1   main images; multi-colour ones use the colours' SKU images
 */
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile } from './catalog-files';
import { currentPrices, holdCredits, microToCents, priceOf, settleHold, type AttemptOutcome, type PriceSnapshot } from './credits';
import { countsSchema, layoutById, rolesFor, type MainRole } from '../listing/layouts';
import { mainPrompt, productPrompt, skuPrompt, type Color, type MainSlot } from './listing-prompts';
import { generateListingImage, LISTING_IMAGE_MODEL, type ImageCall } from './listing-provider';
import { latestOutputs, storeOutput, type Review, type StoredPlan } from './listing-store';
import { upscaleListingImage } from './listing-upscale';
import type { Tenant } from './tenant-scope';

type Stored = StoredPlan & { images: { label: string; assetId: string }[] };
/** `note` is the user's extra instruction on a redo. */
export type JobInput = (
  | { kind: 'product'; sku: string }
  | { kind: 'sku'; sku: string; anchor?: string }
  | { kind: 'main'; slot: MainSlot; skus: string[] }
) & { note?: string };
type PlannedJob = { slot: string; step: 'product' | 'image'; input: JobInput; depends: string[]; multi: boolean };
const db = () => catalogDatabase();
const runHold = (runId: string) => 'listing:run:' + runId;
const action = (input: JobInput) => input.kind === 'main' && input.skus.length > 1 ? 'listing_image_multi' as const : 'listing_image' as const;

/** The colours after the user's renames, in the plan's order; the first is the main colour. */
function colorsOf(stored: Stored, review: Partial<Review> | null): (Color & { sku: string })[] {
  const names = new Map((review?.colors ?? []).map(c => [c.sku, c.name]));
  return stored.plan.product.colors.map(c => ({ sku: c.sku, name: names.get(c.sku) ?? c.name, hex: c.hex }));
}

/** Every image of one confirmed project, with the order it has to be made in. */
export function planJobs(stored: Stored, review: Partial<Review> | null, counts: unknown): PlannedJob[] {
  const colors = colorsOf(stored, review), parsedCounts = countsSchema.parse(counts);
  if (!colors.length) throw new CatalogHttpError(409, '没有认出颜色，出不了图');
  const byName = new Map(stored.plan.product.colors.map((c, i) => [c.name, colors[i]]));
  const jobs: PlannedJob[] = [];
  const [first] = colors;
  for (const c of colors) jobs.push({ slot: `product:${c.sku}`, step: 'product', input: { kind: 'product', sku: c.sku }, depends: [], multi: false });
  for (const c of colors) {
    const anchor = c.sku === first.sku ? undefined : first.sku;
    jobs.push({ slot: `sku:${c.sku}`, step: 'image', input: { kind: 'sku', sku: c.sku, anchor }, depends: [`product:${c.sku}`, ...(anchor ? [`sku:${anchor}`] : [])], multi: false });
  }
  for (const kind of ['square', 'portrait', 'poster'] as const) {
    const wanted = parsedCounts[kind], planned = stored.plan.main[kind].slice(0, wanted);
    const roles: (MainRole | '海报')[] = kind === 'poster' ? ['海报'] : rolesFor(wanted);
    planned.forEach((p, i) => {
      const words = review?.slots?.[`${kind}:${i + 1}`];
      // At most four colours, all known; anything else falls back to the main colour.
      const skus = [...new Set(p.colors.map(name => byName.get(name)?.sku).filter((s): s is string => !!s))].slice(0, 4);
      const used = skus.length ? skus : [first.sku];
      const slot: MainSlot = { kind, n: i + 1, total: planned.length, role: roles[i] ?? '首图', title: words?.title ?? p.title, subtitle: words?.subtitle ?? p.subtitle,
        bullets: (words?.bullets ?? p.bullets).filter(Boolean).slice(0, 3), scene: p.scene, colors: used.map(s => colors.find(c => c.sku === s)!.name) };
      const multi = used.length > 1;
      jobs.push({ slot: `${kind}:${i + 1}`, step: 'image', input: { kind: 'main', slot, skus: used }, depends: multi ? used.map(s => `sku:${s}`) : [`product:${used[0]}`], multi });
    });
  }
  return jobs;
}

const priceFor = (prices: PriceSnapshot, jobs: Pick<PlannedJob, 'multi'>[]) =>
  jobs.reduce((sum, job) => sum + priceOf(prices, job.multi ? 'listing_image_multi' : 'listing_image').userMicroCents, 0);

export async function estimate(stored: Stored, review: Partial<Review> | null, counts: unknown) {
  const jobs = planJobs(stored, review, counts);
  return { images: jobs.length, credits: microToCents(priceFor(await currentPrices(), jobs)) };
}

async function queueRun(c: CatalogQueryClient, tenant: Tenant, user: string, projectId: string, jobs: PlannedJob[], prices: PriceSnapshot) {
  if (!(await c.query("SELECT 1 FROM listing_workers WHERE heartbeat_at>now()-interval '45 seconds' LIMIT 1")).rowCount) {
    throw new CatalogHttpError(503, '电商主图后台未连接，未冻结积分，请稍后再试');
  }
  const runId = randomUUID();
  await holdCredits(c, { id: runHold(runId), tenantId: tenant.id, kind: 'production', jobRef: `listing:run:${projectId}:${runId}`,
    billingMode: tenant.billingMode, amountCents: microToCents(priceFor(prices, jobs)), snapshot: prices });
  for (const job of jobs) {
    // clock_timestamp, not now(): jobs of one run keep their dependency order in the queue.
    await c.query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step,run_id,slot,input,depends,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,
      [randomUUID(), tenant.id, projectId, user, job.step, runId, job.slot, job.input, job.depends]);
  }
  await c.query(`UPDATE listing_projects SET status='generating', error=NULL, updated_at=now() WHERE id=$1`, [projectId]);
  return runId;
}

/** Hold the whole set's credits and queue every image. */
export async function startGeneration(tenant: Tenant, user: string, projectId: string) {
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status,plan,review,counts FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (p.status === 'generating') return { status: 'generating' };
    if (p.status !== 'confirmed') throw new CatalogHttpError(409, p.status === 'done' ? '这一款已经出过图，可以单张重做' : '请先确认素材和卖点');
    await queueRun(c, tenant, user, projectId, planJobs(p.plan, p.review, p.counts), prices);
    return { status: 'generating' };
  });
}

/** Make one image again (optionally with an extra instruction); earlier versions are kept. */
export async function redoSlot(tenant: Tenant, user: string, projectId: string, slot: string, note: string) {
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const p = (await c.query(`SELECT status FROM listing_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [projectId, tenant.id])).rows[0];
    if (!p) throw new CatalogHttpError(404, '商品不存在');
    if (!['done', 'generating'].includes(p.status)) throw new CatalogHttpError(409, '出过图之后才能单张重做');
    const last = (await c.query(`SELECT step,input,depends FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1`, [projectId, slot])).rows[0];
    if (!last) throw new CatalogHttpError(404, '没有这张图');
    if ((await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND slot=$2 AND status IN ('queued','running')`, [projectId, slot])).rowCount) {
      throw new CatalogHttpError(409, '这张图正在出，等它出完再重做');
    }
    const input = { ...last.input, note: note.trim().slice(0, 200) || undefined } as JobInput;
    const jobs: PlannedJob[] = [{ slot, step: last.step, input, depends: last.depends, multi: action(input) === 'listing_image_multi' }];
    // Images that were skipped because this one (or one of them) was missing come along.
    const skipped = (await c.query(`SELECT DISTINCT ON (slot) slot,step,input,depends,status,error FROM listing_jobs
      WHERE project_id=$1 AND slot IS NOT NULL AND slot<>$2 ORDER BY slot, created_at DESC`, [projectId, slot])).rows
      .filter(j => j.status === 'failed' && String(j.error).startsWith('前一步')) as { slot: string; step: 'product' | 'image'; input: JobInput; depends: string[] }[];
    for (let grew = true; grew;) {
      grew = false;
      for (const j of skipped) if (!jobs.some(q => q.slot === j.slot) && j.depends.some(d => jobs.some(q => q.slot === d))) {
        jobs.push({ slot: j.slot, step: j.step, input: j.input, depends: j.depends, multi: action(j.input) === 'listing_image_multi' }); grew = true;
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
    const p = (await db().query('SELECT layout,plan,review FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
    const stored = p.plan as Stored, review = p.review as Partial<Review> | null, layout = layoutById(p.layout);
    if (!layout) throw new Error('版式不存在');
    const colors = colorsOf(stored, review), outputs = await latestOutputs(job.project_id), garment = stored.plan.product.garment;
    const output = async (slot: string) => { const o = outputs.get(slot); if (!o) throw new Error(`缺少前一步的图：${slot}`); return fileOf(o.file_id); };
    const colorOf = (sku: string) => colors.find(c => c.sku === sku) ?? (() => { throw new Error(`颜色不存在：${sku}`); })();
    const input = job.input;
    let prompt: string, references: Buffer[], ratio: 'square' | 'portrait' | 'poster' = 'square';
    if (input.kind === 'product') {
      const assetId = stored.images.find(i => i.label === input.sku)?.assetId;
      const source = assetId && (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [assetId])).rows[0];
      if (!source) throw new Error('找不到这个颜色的 SKU 原图');
      prompt = productPrompt({ color: colorOf(input.sku).name, garment });
      references = [await fileOf(source.file_id)];
    } else if (input.kind === 'sku') {
      prompt = skuPrompt({ layout, color: colorOf(input.sku).name, anchor: input.anchor && colorOf(input.anchor).name, tag: stored.plan.sku.tag, fabric: stored.plan.sku.fabric, garment });
      references = [await output(`product:${input.sku}`), ...(input.anchor ? [await output(`sku:${input.anchor}`)] : [])];
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

/** Per slot: the newest job's state and the current image, for the page. */
export async function slotStates(projectId: string) {
  const jobs = (await db().query(`SELECT DISTINCT ON (slot) slot,status,error,input FROM listing_jobs WHERE project_id=$1 AND slot IS NOT NULL ORDER BY slot, created_at DESC`, [projectId])).rows as { slot: string; status: string; error: string | null; input: JobInput }[];
  const outputs = await latestOutputs(projectId);
  const versions = new Map(((await db().query(`SELECT slot,count(*)::int n FROM listing_assets WHERE project_id=$1 AND slot IS NOT NULL GROUP BY slot`, [projectId])).rows as { slot: string; n: number }[]).map(r => [r.slot, r.n]));
  return jobs.map(j => ({ slot: j.slot, status: j.status, error: j.error, input: j.input, image: outputs.get(j.slot)?.id ?? null, versions: versions.get(j.slot) ?? 0 }));
}

const ROLE_FILE: Record<string, string> = { square: '1比1主图', portrait: '3比4主图', poster: '2比3海报' };
/** Current images named in Taobao order, plus the product images in their own folder. */
export async function downloadZip(projectId: string) {
  const p = (await db().query('SELECT name,plan,review FROM listing_projects WHERE id=$1', [projectId])).rows[0];
  const colors = colorsOf(p.plan as Stored, p.review as Partial<Review> | null);
  const states = await slotStates(projectId), outputs = await latestOutputs(projectId), zip = new JSZip();
  for (const s of states) {
    const o = outputs.get(s.slot); if (!o) continue;
    const [kind, key] = s.slot.split(':');
    const color = colors.find(c => c.sku === key)?.name ?? key;
    const ext = o.name.split('.').pop() === 'jpeg' ? 'jpg' : 'png';
    const name = kind === 'product' ? `白底产品图/${color}.${ext}` : kind === 'sku' ? `SKU-${color}.${ext}`
      : kind === 'poster' ? `${ROLE_FILE.poster}.${ext}` : `${ROLE_FILE[kind]}-${key.padStart(2, '0')}-${s.input.kind === 'main' ? s.input.slot.role : ''}.${ext}`;
    zip.file(name, await fileOf(o.file_id));
  }
  if (!Object.keys(zip.files).length) throw new CatalogHttpError(409, '还没有出好的图');
  return { name: `${p.name}-电商主图.zip`, bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) };
}
