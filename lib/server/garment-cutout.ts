import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { digest, readAsset, storeAsset } from './garment-mockup-store';
import { currentPrices, holdCredits, settleHold, releaseHold, microToCents } from './credits';
import type { Tenant } from './tenant-scope';
import { inspectArtworkSource, removeFlatArtworkBackground, alphaMaskReport } from './artwork-image-processing';
import { volcengineSaliencyCutout } from './garment-mockup-provider';

// Bump when routing or local processing changes: the cache key includes it.
export const GARMENT_CUTOUT_VERSION = 'garment-cutout-v1';
const MAX_EDGE = 2048;
const modeSchema = z.enum(['auto', 'standard', 'graphic']);
export type GarmentCutoutMode = z.infer<typeof modeSchema>;
type Route = 'cache' | 'passthrough' | 'local_flat' | 'provider';
type EngineId = 'volcengine' | 'meitu';
type Timings = Record<string, number>;
export type GarmentCutoutMeta = {
  jobId: string; status: 'succeeded'; route: Route; engine: EngineId | 'local' | null; model: string | null;
  fallbackFrom: EngineId | null; cached: boolean; charged: boolean; width: number; height: number; timingMs: Timings;
};
export type GarmentCutoutOutcome =
  | { status: 200; png: Buffer; meta: GarmentCutoutMeta; persist?: () => Promise<void> }
  | { status: 202; jobId: string };

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const instanceOwner = randomUUID();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Raised when the provider never received the paid request; the hold can be released. */
export class NotSubmittedError extends Error {}
/** Raised when a paid request left but its outcome is unknown; never resubmit it. */
export class UnknownOutcomeError extends Error {}

type EngineHooks = { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> };
export type GarmentCutoutEngine = { id: EngineId; model: string; timeoutMs: number; configured: () => boolean; run: (png: Buffer, requestId: string, hooks: EngineHooks) => Promise<Buffer> };

const volcengine: GarmentCutoutEngine = {
  id: 'volcengine', model: 'saliency_seg', timeoutMs: 10_000,
  configured: () => !!process.env.VOLCENGINE_ACCESS_KEY && !!process.env.VOLCENGINE_SECRET_KEY,
  async run(png, _requestId, hooks) {
    let submitted = false;
    const paidFetch: typeof fetch = async (url, init) => {
      await hooks.beforeSubmit(); submitted = true;
      try { return await fetch(url, { ...init, redirect: 'error' }); }
      catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new UnknownOutcomeError('火山抠图超时，结果待核实');
        throw new UnknownOutcomeError(`火山抠图连接中断：${errorText(error)}`);
      }
    };
    try { return (await volcengineSaliencyCutout(png, { fetchImplementation: paidFetch, receipt: hooks.receipt, timeoutMs: this.timeoutMs })).bytes; }
    catch (error) { if (!submitted) throw new NotSubmittedError(errorText(error)); throw error; }
  },
};

const meitu: GarmentCutoutEngine = {
  id: 'meitu', model: 'image-cutout-graphic-2', timeoutMs: 20_000,
  configured: () => !!process.env.MEITU_OPENAPI_ACCESS_KEY && !!process.env.MEITU_OPENAPI_SECRET_KEY,
  async run(png, requestId, hooks) {
    // Loaded lazily: the SDK resolves its runtime from disk and must not break the volcengine path.
    let api: typeof import('./meitu-cutout');
    let imageUrl: string;
    try { api = await import('./meitu-cutout'); imageUrl = await api.uploadMeituCutoutInput(png); }
    catch (error) { throw new NotSubmittedError(`美图上传未完成：${errorText(error)}`); }
    await hooks.beforeSubmit();
    let submitted: Awaited<ReturnType<typeof api.submitMeituCutout>>;
    try { submitted = await api.submitMeituCutout(imageUrl, requestId); }
    catch (error) {
      if (error instanceof api.MeituSubmissionNotStartedError) throw new NotSubmittedError(errorText(error));
      throw new UnknownOutcomeError(`美图提交结果待核实：${errorText(error)}`);
    }
    const code = submitted.code || submitted.error_code;
    if (code) {
      if ([90009, 10002, 599, 500, 502, 503, 504].includes(code)) throw new UnknownOutcomeError(`美图提交待核实（${code}）`);
      throw new Error(`美图抠图失败（${code}）：${submitted.message || '服务暂不可用'}`);
    }
    const taskId = submitted.data?.task_id;
    if (!taskId) throw new UnknownOutcomeError('美图提交未返回任务编号，结果待核实');
    await hooks.receipt(taskId);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const task = await api.queryMeituCutout(taskId).catch(() => null);
      const status = task?.data?.status;
      if (status === 10) {
        const url = task?.data?.result?.media_info_list?.[0]?.media_data;
        if (!url) throw new UnknownOutcomeError('美图任务完成但缺少图片地址');
        return api.downloadMeituCutout(url);
      }
      if (status === 2 || (typeof status === 'number' && status < 0)) throw new Error(task?.message || '美图任务处理失败');
    }
    throw new UnknownOutcomeError('美图抠图超时，结果待核实');
  },
};

/** Engines by id. Integration tests swap entries for stubs; production never reassigns them. */
export const garmentCutoutEngineRegistry: Record<EngineId, GarmentCutoutEngine> = { volcengine, meitu };
export function garmentCutoutEngines(mode: 'standard' | 'graphic') {
  const { volcengine: standard, meitu: graphic } = garmentCutoutEngineRegistry;
  return (mode === 'graphic' ? [graphic, standard] : [standard, graphic]).filter(engine => engine.configured());
}

/** Rotate, flatten to PNG and cap the long edge. Every cache key uses these exact bytes. */
async function normalize(bytes: Buffer) {
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch { throw new CatalogHttpError(400, '图片无法读取，请换一张 PNG / JPG / WebP'); }
}

/** A usable foreground: something visible and a real transparent background. */
async function usableCutout(png: Buffer) {
  const report = await alphaMaskReport(png);
  return report.visibleRatio >= 0.003 && report.transparentRatio >= 0.01;
}

/** Background-colored pixels the flood fill could not reach (letter counters, white fills). */
async function enclosedBackgroundRatio(png: Buffer, color: { r: number; g: number; b: number }) {
  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let visible = 0, enclosed = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 8) continue;
    visible++;
    if (data[i + 3] >= 200 && (data[i] - color.r) ** 2 + (data[i + 1] - color.g) ** 2 + (data[i + 2] - color.b) ** 2 <= 24 ** 2) enclosed++;
  }
  return visible ? enclosed / visible : 1;
}

/** Free paths: an already transparent logo, or (in auto mode) a flat background with nothing enclosed. */
async function localCutout(png: Buffer, allowFlat: boolean): Promise<{ route: Route; png: Buffer } | null> {
  const profile = await inspectArtworkSource(png);
  if (profile.kind === 'transparent') return { route: 'passthrough', png };
  if (!allowFlat || profile.kind !== 'flat-background' || !profile.backgroundColor) return null;
  const removed = await removeFlatArtworkBackground(png, profile.backgroundColor);
  if (!(await usableCutout(removed))) return null;
  // Enclosed background (white inside letters) would show on the garment; let a model decide.
  if (await enclosedBackgroundRatio(removed, profile.backgroundColor) > 0.003) return null;
  return { route: 'local_flat', png: removed };
}

type JobRow = { id: string; tenant_id: string; request_hash: string; status: string; error: string | null; result_json: Record<string, unknown> | null };
function statusError(job: JobRow): never {
  if (job.status === 'unknown') throw new CatalogHttpError(504, job.error || '去背景结果待核实，不会自动重复扣费');
  throw new CatalogHttpError(502, job.error || '去背景未完成，未扣费，可重试');
}

async function readResult(tenant: string, result: Record<string, unknown>) {
  const url = (result.assets as { result?: string } | undefined)?.result;
  const id = url?.split('/').pop();
  return id ? (await readAsset(tenant, id)).bytes : null;
}

export async function runGarmentCutout(tenant: Tenant, userId: string, value: {
  requestId: string; mode?: string | null; projectId?: string | null; elementId?: string | null; fileName?: string | null; bytes: Buffer;
}): Promise<GarmentCutoutOutcome> {
  const started = Date.now(), timings: Timings = {};
  const input = z.object({
    requestId: z.uuid(), mode: modeSchema.default('auto'), projectId: z.uuid().nullable().default(null),
    elementId: z.string().max(80).nullable().default(null), fileName: z.string().max(200).nullable().default(null),
  }).parse({ requestId: value.requestId, mode: value.mode || undefined, projectId: value.projectId || null, elementId: value.elementId || null, fileName: value.fileName || null });
  const { png: source, width, height } = await normalize(value.bytes);
  timings.normalize = Date.now() - started;
  const sourceSha256 = sha256(source);
  const mode: 'standard' | 'graphic' = input.mode === 'graphic' ? 'graphic' : 'standard';
  // An explicit engine choice skips the local flat-background path, so it caches separately.
  const cacheKey = `${input.mode}:${GARMENT_CUTOUT_VERSION}`;
  const requestHash = digest({ sourceSha256, mode: input.mode, projectId: input.projectId });
  const db = catalogDatabase();

  // Same request number: return its outcome, never run it twice.
  const previous = (await db.query('SELECT id,tenant_id,request_hash,status,error,result_json FROM garment_mockup_ai_jobs WHERE id=$1', [input.requestId])).rows[0] as JobRow | undefined;
  if (previous) {
    if (previous.tenant_id !== tenant.id || previous.request_hash !== requestHash) throw new CatalogHttpError(409, '请求编号已用于另一张图片');
    if (previous.status === 'succeeded') {
      const bytes = previous.result_json ? await readResult(tenant.id, previous.result_json) : null;
      if (!bytes) return { status: 202, jobId: previous.id };
      return { status: 200, png: bytes, meta: { ...(previous.result_json!.meta as GarmentCutoutMeta), jobId: previous.id } };
    }
    if (['queued', 'running'].includes(previous.status)) return { status: 202, jobId: previous.id };
    statusError(previous);
  }
  if (input.projectId && !(await db.query('SELECT 1 FROM garment_mockup_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [input.projectId, tenant.id])).rowCount)
    throw new CatalogHttpError(404, '作品不存在');
  const jobInput = { mode: input.mode, sourceSha256, elementId: input.elementId, fileName: input.fileName, execution: 'inline', width, height };
  const baseName = (input.fileName || 'Logo').replace(/\.[a-z0-9]+$/i, '').slice(0, 60);
  const meta = (route: Route, extra: Partial<GarmentCutoutMeta>): GarmentCutoutMeta => ({
    jobId: input.requestId, status: 'succeeded', route, engine: null, model: null, fallbackFrom: null,
    cached: route === 'cache', charged: false, width, height, timingMs: { ...timings, total: Date.now() - started }, ...extra,
  });
  // Stored after the response. The saved project never depends on it: the browser uploads its own copy.
  const persister = (result: Buffer, engine: string | null) => async () => {
    try {
      const sourceAsset = await storeAsset(tenant.id, source, `${baseName}-原图.png`, { kind: 'logo_source', jobId: input.requestId });
      const resultAsset = await storeAsset(tenant.id, result, `${baseName}-透明.png`, { kind: 'logo_cutout', jobId: input.requestId, engine });
      await db.query(`UPDATE garment_mockup_ai_jobs SET result_json=result_json || $2::jsonb, updated_at=now() WHERE id=$1`,
        [input.requestId, { transparent: resultAsset.url, assets: { state: 'done', source: sourceAsset.url, result: resultAsset.url } }]);
    } catch (error) {
      await db.query(`UPDATE garment_mockup_ai_jobs SET result_json=result_json || $2::jsonb WHERE id=$1`,
        [input.requestId, { assets: { state: 'failed', error: errorText(error) } }]).catch(() => {});
    }
  };
  const recordFree = async (route: Route, result: Buffer, extra: Partial<GarmentCutoutMeta>, assets?: unknown) => {
    const m = meta(route, extra);
    await db.query(`INSERT INTO garment_mockup_ai_jobs(id,tenant_id,user_id,project_id,action,input_json,request_hash,status,result_json)
      VALUES($1,$2,$3,$4,'cutout',$5,$6,'succeeded',$7) ON CONFLICT (id) DO NOTHING`,
    [input.requestId, tenant.id, userId, input.projectId, jobInput, requestHash, { meta: m, cacheKey, route, engine: m.engine, timings: m.timingMs, ...(assets ? { assets, transparent: (assets as { result: string }).result } : { assets: { state: 'pending' } }) }]);
    return m;
  };

  // 1. The same tenant already cut out these exact bytes: reuse, free.
  const hit = (await db.query(`SELECT id,result_json FROM garment_mockup_ai_jobs WHERE tenant_id=$1 AND action='cutout' AND status='succeeded'
      AND input_json->>'sourceSha256'=$2 AND result_json->>'cacheKey'=$3 AND result_json->'assets'->>'state'='done' ORDER BY created_at DESC LIMIT 1`,
  [tenant.id, sourceSha256, cacheKey])).rows[0] as { id: string; result_json: Record<string, unknown> } | undefined;
  timings.lookup = Date.now() - started - timings.normalize;
  if (hit) {
    const bytes = await readResult(tenant.id, hit.result_json).catch(() => null);
    if (bytes) {
      const cachedMeta = hit.result_json.meta as GarmentCutoutMeta | undefined;
      const m = await recordFree('cache', bytes, { engine: cachedMeta?.engine ?? null, model: cachedMeta?.model ?? null }, hit.result_json.assets);
      return { status: 200, png: bytes, meta: m };
    }
  }

  // 2. Already transparent, or (auto only) a flat background with nothing enclosed: local, free.
  const localStarted = Date.now();
  const local = await localCutout(source, input.mode === 'auto').catch(() => null);
  timings.local = Date.now() - localStarted;
  if (local) {
    const m = await recordFree(local.route, local.png, { engine: 'local' });
    return { status: 200, png: local.png, meta: m, persist: persister(local.png, 'local') };
  }

  // 3. A model: hold once, primary engine, then at most one fallback.
  const engines = garmentCutoutEngines(mode);
  if (!engines.length) throw new CatalogHttpError(503, '去背景服务未配置，未扣费');
  const prices = await currentPrices(), price = prices.prices.find(p => p.action === 'cutout');
  if (!price) throw new CatalogHttpError(503, '当前操作缺少计费配置');
  const holdId = 'garment:' + input.requestId;
  const claimed = await catalogTransaction(async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['garment-ai:' + input.requestId]);
    if ((await c.query('SELECT 1 FROM garment_mockup_ai_jobs WHERE id=$1', [input.requestId])).rowCount) return false;
    await holdCredits(c, { id: holdId, tenantId: tenant.id, kind: 'production', jobRef: 'garment:cutout:' + input.requestId, billingMode: tenant.billingMode, amountCents: microToCents(price.userMicroCents), snapshot: prices });
    // A lease lets the worker's sweep settle a job whose web process died mid-call.
    await c.query(`INSERT INTO garment_mockup_ai_jobs(id,tenant_id,user_id,project_id,action,input_json,request_hash,status,owner,lease_until)
      VALUES($1,$2,$3,$4,'cutout',$5,$6,'running',$7,now()+interval '2 minutes')`, [input.requestId, tenant.id, userId, input.projectId, jobInput, requestHash, instanceOwner]);
    return true;
  });
  if (!claimed) return { status: 202, jobId: input.requestId };

  const attempts: { id: string; engine: EngineId; status: 'succeeded' | 'failed' | 'unknown'; latencyMs: number; reason?: string; error?: string }[] = [];
  const publicAttempts = () => attempts.map(({ engine, status, latencyMs, reason, error }) => ({ engine, status, latencyMs, reason, error }));
  const providerStarted = Date.now();
  for (const [index, engine] of engines.entries()) {
    const attemptId = randomUUID(), attemptStarted = Date.now();
    let submitted = false;
    const hooks: EngineHooks = {
      beforeSubmit: async () => {
        await db.query(`INSERT INTO garment_mockup_ai_attempts(id,job_id,provider,model,status) VALUES($1,$2,$3,$4,'submitted')`, [attemptId, input.requestId, engine.id, engine.model]);
        submitted = true;
      },
      receipt: async id => { await db.query('UPDATE garment_mockup_ai_attempts SET provider_request_id=$2 WHERE id=$1', [attemptId, id]); },
    };
    const finishAttempt = async (status: 'succeeded' | 'failed' | 'unknown', receipt: Record<string, unknown>) => {
      const latencyMs = Date.now() - attemptStarted;
      if (submitted) await db.query('UPDATE garment_mockup_ai_attempts SET status=$2,receipt=$3,finished_at=now() WHERE id=$1', [attemptId, status, { seq: index + 1, latencyMs, ...receipt }]);
      else await db.query(`INSERT INTO garment_mockup_ai_attempts(id,job_id,provider,model,status,receipt,finished_at) VALUES($1,$2,$3,$4,'failed',$5,now())`,
        [attemptId, input.requestId, engine.id, engine.model, { seq: index + 1, latencyMs, ...receipt }]);
      return latencyMs;
    };
    try {
      const result = await engine.run(source, input.requestId, hooks);
      const png = await sharp(result).ensureAlpha().png().toBuffer();
      if (!(await usableCutout(png))) {
        attempts.push({ id: attemptId, engine: engine.id, status: 'failed', reason: 'empty_mask', latencyMs: await finishAttempt('failed', { fallbackReason: 'empty_mask' }) });
        continue;
      }
      const latencyMs = await finishAttempt('succeeded', { outputSha256: sha256(png) });
      attempts.push({ id: attemptId, engine: engine.id, status: 'succeeded', latencyMs });
      timings.provider = Date.now() - providerStarted;
      // Charge once, whatever happened to earlier attempts.
      await settleHold(holdId, tenant.id, [{ action: 'cutout', billable: true, certain: true, attemptId }]);
      const m = meta('provider', { engine: engine.id, model: engine.model, fallbackFrom: index > 0 ? engines[0].id : null, charged: tenant.billingMode === 'charge' });
      await db.query(`UPDATE garment_mockup_ai_jobs SET status='succeeded',result_json=$2,lease_until=NULL,updated_at=now() WHERE id=$1`,
        [input.requestId, { meta: m, cacheKey, route: 'provider', engine: engine.id, model: engine.model, timings: m.timingMs, attempts: publicAttempts(), assets: { state: 'pending' } }]);
      return { status: 200, png, meta: m, persist: persister(png, engine.id) };
    } catch (error) {
      // The provider answered with a definite failure unless the call itself timed out or broke off.
      const unknown = submitted && !(error instanceof NotSubmittedError)
        && (error instanceof UnknownOutcomeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')));
      const reason = error instanceof NotSubmittedError ? 'not_submitted' : unknown ? 'timeout' : 'provider_error';
      const latencyMs = await finishAttempt(unknown ? 'unknown' : 'failed', { fallbackReason: reason, error: errorText(error) });
      attempts.push({ id: attemptId, engine: engine.id, status: unknown ? 'unknown' : 'failed', reason, error: errorText(error), latencyMs });
    }
  }
  timings.provider = Date.now() - providerStarted;
  const firstUnknown = attempts.find(a => a.status === 'unknown');
  const summary = attempts.map(a => `${a.engine === 'meitu' ? '美图' : '火山'}：${a.error || a.reason}`).join('；');
  if (firstUnknown) await settleHold(holdId, tenant.id, [{ action: 'cutout', billable: true, certain: false, attemptId: firstUnknown.id }]).catch(() => {});
  else await releaseHold(holdId, tenant.id, '去背景未成功，全额退回').catch(() => {});
  const status = firstUnknown ? 'unknown' : 'failed';
  const message = firstUnknown ? `去背景结果待核实，不会自动重复扣费（${summary}）` : `去背景未完成，未扣费（${summary}）`;
  await db.query(`UPDATE garment_mockup_ai_jobs SET status=$2,error=$3,result_json=$4,lease_until=NULL,updated_at=now() WHERE id=$1`,
    [input.requestId, status, message.slice(0, 500), { cacheKey, route: 'provider', timings: { ...timings, total: Date.now() - started }, attempts: publicAttempts() }]);
  throw new CatalogHttpError(firstUnknown ? 504 : 502, message);
}

export async function garmentCutoutStatus(tenant: string, id: string) {
  z.uuid().parse(id);
  const job = (await catalogDatabase().query(`SELECT id,status,error,result_json,created_at FROM garment_mockup_ai_jobs WHERE id=$1 AND tenant_id=$2 AND action='cutout'`, [id, tenant])).rows[0];
  if (!job) throw new CatalogHttpError(404, '去背景任务不存在');
  const r = (job.result_json ?? {}) as Record<string, unknown>;
  return { jobId: job.id, status: job.status, error: job.error, meta: r.meta ?? null, attempts: r.attempts ?? [], assets: r.assets ?? null, timings: r.timings ?? null };
}
