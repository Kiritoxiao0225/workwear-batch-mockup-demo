/**
 * 电商主图 background work. Same lifecycle as the garment AI queue: credits are held before a job
 * exists, a provider call is recorded before it is sent, and a sent call is never repeated.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile } from './catalog-files';
import { currentPrices, holdCredits, microToCents, priceOf, releaseHold, settleHold } from './credits';
import { countsSchema } from '../listing/layouts';
import { claimLayout, executeLayout, renewLayoutLease, resolveLayout } from './listing-layouts';
import { addDuplicates, parsePlan, planRequest } from './listing-plan';
import { planViews, type PlanSource } from './listing-plan-views';
import { assertListingProviderConfigured, callPlanModel, LISTING_PLAN_MODEL, type PlanCall } from './listing-provider';
import { clearOldSources, sourceImages, type StoredPlan } from './listing-store';
import { executeImage, failBlocked, finishRun, type JobInput, type Upscale } from './listing-generation';
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

export async function executePlan(job: JobRow, provider: Provider = (request, hooks) => callPlanModel(request, hooks)) {
  const attemptId = randomUUID(), model = LISTING_PLAN_MODEL();
  let submitted = false;
  const fail = async (message: string, status: 'failed' | 'unknown') => {
    await db().query(`UPDATE listing_jobs SET status=$2,error=$3,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, status, message.slice(0, 500)]);
    await db().query(`UPDATE listing_projects SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='planning'`, [job.project_id, message.slice(0, 500)]);
  };
  try {
    const hold = (await db().query('SELECT state FROM credit_holds WHERE id=$1 AND tenant_id=$2', [holdId(job.id), job.tenant_id])).rows[0];
    if (hold?.state !== 'held') throw new Error('缺少有效积分冻结');
    const project = (await db().query('SELECT layout,counts FROM listing_projects WHERE id=$1', [job.project_id])).rows[0];
    const layout = await resolveLayout(job.tenant_id, project.layout);
    if (!layout) throw new Error('版式不存在');
    const { sources, map } = await planSources(job.project_id);
    const { views, duplicates } = await planViews(sources);
    const request = planRequest({ views, counts: countsSchema.parse(project.counts), layout, model });
    const call = await provider(request, {
      beforeSubmit: async () => {
        await db().query(`INSERT INTO listing_attempts(id,job_id,provider,model,status) VALUES($1,$2,'evolink',$3,'submitted')`, [attemptId, job.id, model]);
        submitted = true;
      },
      receipt: async id => { await db().query('UPDATE listing_attempts SET provider_request_id=$2 WHERE id=$1', [attemptId, id]); },
    });
    // The call succeeded and is paid for, whatever the content turns out to be.
    await db().query(`UPDATE listing_attempts SET status='succeeded',receipt=$2,finished_at=now() WHERE id=$1`,
      [attemptId, { model: call.model, usage: call.usage, durationMs: call.durationMs }]);
    await settleHold(holdId(job.id), job.tenant_id, [{ action: 'listing_plan', billable: true, certain: true, attemptId }]);
    let parsed: ReturnType<typeof parsePlan>;
    try { parsed = addDuplicates(parsePlan(call.content, sources.filter(s => !duplicates.has(s.id))), duplicates); } catch (error) {
      await fail('分析结果不完整：' + (error instanceof Error ? error.message : '格式错误') + '。本次已扣费，可以重新分析', 'failed');
      return;
    }
    const stored: StoredPlan & { images: typeof map } = { ...parsed, model: call.model, images: map };
    await db().query(`UPDATE listing_projects SET status='review',plan=$2,review=NULL,error=NULL,updated_at=now() WHERE id=$1`, [job.project_id, stored]);
    await db().query(`UPDATE listing_jobs SET status='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '分析失败';
    const settled = submitted && (await db().query('SELECT status FROM listing_attempts WHERE id=$1', [attemptId])).rows[0]?.status === 'succeeded';
    if (submitted && !settled && (error as { definite?: boolean }).definite) {
      // The provider refused the request outright (4xx): nothing was produced or charged.
      await db().query(`UPDATE listing_attempts SET status='failed',finished_at=now() WHERE id=$1`, [attemptId]);
      await releaseHold(holdId(job.id), job.tenant_id, '分析接口拒绝').catch(() => {});
      await fail(`${message}（接口拒绝了这次请求）。未扣费，可以重新分析`, 'failed');
    } else if (submitted) {
      // A request that reached the provider may have been charged; it is never sent again.
      await db().query(`UPDATE listing_attempts SET status=CASE WHEN status='succeeded' THEN status ELSE 'unknown' END,finished_at=now() WHERE id=$1`, [attemptId]);
      const certain = (await db().query('SELECT status FROM listing_attempts WHERE id=$1', [attemptId])).rows[0]?.status === 'succeeded';
      await settleHold(holdId(job.id), job.tenant_id, [{ action: 'listing_plan', billable: true, certain, attemptId }]).catch(() => {});
      await fail(`${message}。可能已产生费用，由管理员核对`, 'unknown');
    } else {
      await releaseHold(holdId(job.id), job.tenant_id, '未提交模型').catch(() => {});
      await fail(`${message}。未扣费，可以重新分析`, 'failed');
    }
  }
}

/**
 * Runs up to `LISTING_WORKER_CONCURRENCY` jobs at once (images mostly wait on the provider). An
 * image job starts only when the images it builds on exist; if one of them failed, it is
 * skipped and costs nothing.
 */
export async function startListingWorker({ canAccept = () => true, concurrency = Number(process.env.LISTING_WORKER_CONCURRENCY || 6), generate, upscale, learn }: { canAccept?: () => boolean; concurrency?: number; generate?: Parameters<typeof executeImage>[1]; upscale?: Upscale; learn?: Parameters<typeof executeLayout>[1] } = {}) {
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
      if (j.step !== 'plan') { await finishRun(j.run_id, j.tenant_id, j.project_id); continue; }
      const attempts = (await db().query('SELECT id,status FROM listing_attempts WHERE job_id=$1', [j.id])).rows;
      if (attempts.length) await settleHold(holdId(j.id), j.tenant_id, attempts.map(a => ({ action: 'listing_plan' as const, billable: true, certain: a.status === 'succeeded', attemptId: a.id }))).catch(() => {});
      else await releaseHold(holdId(j.id), j.tenant_id, '后台在提交前中断').catch(() => {});
      await db().query(`UPDATE listing_projects SET status='failed',error='后台中断，请重新分析',updated_at=now() WHERE id=$1 AND status='planning'`, [j.project_id]);
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
    const task = (job.step === 'plan' ? executePlan(job) : executeImage(job, generate, upscale))
      .catch(error => console.error('[listing-worker]', error instanceof Error ? error.message : 'error'))
      .finally(() => { clearInterval(beat); running.delete(task); });
    running.add(task);
  };
  let clearedAt = 0;
  const tick = async () => {
    if (closed || ticking || !canAccept()) return;
    ticking = true;
    try {
      await sweep();
      // Old products' source images: checked hourly; an advisory lock keeps the workers apart.
      if (Date.now() - clearedAt > 3600_000) { clearedAt = Date.now(); await clearOldSources().catch(error => console.error('[listing-worker] clear', error instanceof Error ? error.message : 'error')); }
      while (!closed && running.size < concurrency) {
        const next = await claim();
        if (!next) break;
        if ('blocked' in next && next.blocked) { await failBlocked(next.blocked, next.reason!); continue; }
        if ('job' in next && next.job) run(next.job);
      }
      // A layout to learn: one call to read the references, then three sample images.
      if (!closed && running.size < concurrency) {
        const layout = await claimLayout(owner);
        if (layout) {
          const beat = setInterval(() => { void renewLayoutLease(layout.id, owner).catch(() => {}); }, 15000);
          const task = executeLayout(layout, learn).catch(error => console.error('[listing-worker] layout', error instanceof Error ? error.message : 'error'))
            .finally(() => { clearInterval(beat); running.delete(task); });
          running.add(task);
        }
      }
    } catch (error) { console.error('[listing-worker]', error instanceof Error ? error.name : 'error'); } finally { ticking = false; }
  };
  const timer = setInterval(() => void tick(), 2000);
  void tick();
  return {
    close: async () => {
      closed = true; clearInterval(timer); clearInterval(beatTimer); await Promise.all(running);
      await db().query(`UPDATE listing_workers SET heartbeat_at=now()-interval '1 day' WHERE id=$1`, [owner]);
    },
  };
}
