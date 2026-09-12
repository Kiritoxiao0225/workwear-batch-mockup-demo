import { ARTWORK_INTEGRITY_VERSION } from './artwork-foreground-integrity';
import { alphaMaskReport, assertUsableArtworkMask } from './artwork-image-processing';
import { assertArtworkMask } from './artwork-panel-mask';
import { protectExplicitArtwork } from './artwork-explicit-protection';
import type { ArtworkProtectionPolicy } from '@/lib/artwork-protection';
import type { ArtworkCutoutReceipt } from '@/lib/artwork-cutout';
import { artworkJobStep, currentCutoutRecovery } from './artwork-job-runtime';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { ArtworkCutoutMode, ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { ARTWORK_CUTOUT_VERSION } from '@/lib/artwork-cutout';
import { analyzeArtworkCutout, validateCutoutOutput, ArtworkCutoutContentError } from './artwork-cutout-analysis';
import { inspectArtworkSource, removeFlatArtworkBackground } from './artwork-image-processing';
import { assertCutoutStoreReady, readCutoutJob, claimCutoutJob, saveCutoutJob, type StoredCutout } from './artwork-cutout-store';
import { MEITU_CUTOUT_VERSION, MeituSubmissionNotStartedError, uploadMeituCutoutInput, submitMeituCutout, queryMeituCutout, downloadMeituCutout, meituCutoutCredits } from './meitu-cutout';
import { productionStateKey } from './production-storage';
import { submitArtworkBackgroundRemoval, downloadArtworkBackgroundRemoval } from './media-kit-artwork';
import { protectArtworkBadges } from './artwork-badge-protection';
import { inspectArtworkWatermarks } from './artwork-content-inspection';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const inline = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
export const cutoutServices = { upload: uploadMeituCutoutInput, submit: submitMeituCutout, query: queryMeituCutout, download: downloadMeituCutout, credits: meituCutoutCredits,
  volcano: submitArtworkBackgroundRemoval, volcanoDownload: downloadArtworkBackgroundRemoval, inspectWatermarks: inspectArtworkWatermarks };
export type CutoutServices = typeof cutoutServices;
function publicResult(job: StoredCutout, cacheHit = false): ArtworkCutoutResult { return { status: job.status, url: job.url, error: job.error, candidate: job.candidate, receipt: { ...job.receipt, cacheHit } }; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

async function checkedProviderOutput(bytes: Buffer, job: StoredCutout, services: CutoutServices) {
  const metadata = await sharp(bytes).metadata();
  if (metadata.width && metadata.height) job.candidate = { url: inline(bytes), width: metadata.width, height: metadata.height, missingRegions: [] };
  // Save the raw supplier result BEFORE restoration or validation. Its identity
  // survives even if the protected candidate fails. Existing pack() retains URLs.
  job.receipt.providerOutputUrl = inline(bytes);
  job.receipt.localValidationVersion = ARTWORK_INTEGRITY_VERSION;
  job.receipt.diagnostics = { stage: 'provider-mask' };
  await saveCutoutJob(job);
  const rawMask = await alphaMaskReport(bytes);
  job.receipt.diagnostics.rawMask = rawMask;
  try { assertUsableArtworkMask(rawMask); }
  catch (error) { job.receipt.diagnostics.rawMaskError = errorText(error); }
  const source = Buffer.from(job.receipt.sourceUrl.split(',')[1], 'base64');
  job.receipt.diagnostics.stage = 'protection';
  const explicit = await protectExplicitArtwork(source, bytes, job.receipt.protection);
  const protectedResult = await protectArtworkBadges(source, explicit.bytes, job.receipt.protection?.background);
  if (job.candidate) job.candidate.url = inline(protectedResult.bytes);
  await saveCutoutJob(job);
  job.receipt.diagnostics.stage = 'final-mask';
  const mask = await assertArtworkMask(protectedResult.bytes, job.receipt.protection);
  job.receipt.diagnostics.acceptance = mask.acceptance;
  if (explicit.protectedPanels) job.receipt.reasons.push(`按明确要求保留 ${explicit.protectedPanels} 个红色底形及其原字，圆角外部不恢复`);
  job.receipt.diagnostics.stage = 'completeness';
  try {
    const checked = await validateCutoutOutput(protectedResult.bytes, source, { inspectWatermarks: services.inspectWatermarks, protection: job.receipt.protection });
    const { watermarks, integrity } = checked;
    job.receipt.integrityCheck = integrity;
    if (integrity.warning) job.receipt.reasons.push(integrity.warning);
    if (watermarks.length) {
      job.receipt.excludedWatermarks = watermarks;
      job.receipt.reasons.push(`完整性检查已排除确认的生成平台水印：${[...new Set(watermarks.map(mark => mark.text))].join('、')}`);
    }
  } catch (error) {
    if (job.candidate && error instanceof ArtworkCutoutContentError) job.candidate.missingRegions = error.missingRegions;
    throw error;
  }
  if (protectedResult.regions.length) {
    job.receipt.badgeProtection = { regions: protectedResult.regions.length, restoredPixels: protectedResult.restoredPixels };
    const reason = `已保护 ${protectedResult.regions.length} 个圆形徽章，圆内使用原图像素，保留底色与白色图形`;
    if (!job.receipt.reasons.includes(reason)) job.receipt.reasons.push(reason);
  }
  job.receipt.diagnostics.stage = 'completed';
  if (job.receipt.integrityCheck?.status !== 'uncertain') job.candidate = undefined;
  return protectedResult.bytes;
}

function samePolicy(a?: ArtworkProtectionPolicy, b?: ArtworkProtectionPolicy) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Policy/integrity changes create local derivatives, not new paid submissions.
 * Old jobs and finalized artwork remain untouched, and pending parents are queried. */
async function localValidationResult(parent: StoredCutout, protection: ArtworkProtectionPolicy | undefined, services: CutoutServices) {
  const key = sha(JSON.stringify([parent.receipt.jobKey, ARTWORK_INTEGRITY_VERSION, protection ?? null]));
  const existing = await readCutoutJob(key);
  if (existing) return queryArtworkCutout(key, services);
  const job: StoredCutout = { status: 'pending', phase: 'ready', requestId: randomUUID(), updatedAt: new Date().toISOString(),
    receipt: { ...parent.receipt, jobKey: key, protection, reusedFrom: parent.receipt.jobKey, localValidationOnly: true,
      localValidationVersion: ARTWORK_INTEGRITY_VERSION, route: 'reuse', actualCredits: 0, estimatedCredits: 0,
      cacheHit: true, outputSha256: undefined, completedAt: undefined, badgeProtection: undefined,
      excludedWatermarks: undefined, diagnostics: undefined, integrityCheck: undefined,
      reasons: [...parent.receipt.reasons.map(reason => `[原任务] ${reason}`), '复用同一供应商任务，仅本地按当前背景范围与完整性合同核查；不重新付费'] } };
  await claimCutoutJob(job);
  return queryArtworkCutout(key, services);
}

async function finishLocalValidation(job: StoredCutout, services: CutoutServices): Promise<ArtworkCutoutResult> {
  let parent = await readCutoutJob(job.receipt.reusedFrom!);
  if (!parent) return { ...publicResult(job), status: 'unknown', error: '原供应商任务记录缺失；不重新提交，请核对原始候选' };
  if (!['completed', 'failed'].includes(parent.status)) {
    const result = await queryArtworkCutout(parent.receipt.jobKey, services);
    if (!['completed', 'failed'].includes(result.status)) return { ...publicResult(job), status: result.status, error: result.error };
    parent = (await readCutoutJob(parent.receipt.jobKey))!;
  }
  const rawUrl = parent.receipt.providerOutputUrl;
  const url = rawUrl ?? parent.candidate?.url ?? parent.url;
  if (!url) {
    job.status = 'failed'; job.phase = 'finished'; job.error = parent.error || '原任务没有可复核的图片；不重新提交';
    await saveCutoutJob(job); return publicResult(job);
  }
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  const meta = await sharp(bytes).metadata();
  job.candidate = { url, width: meta.width!, height: meta.height!, missingRegions: [] };
  try {
    // Legacy badge-restored outputs cannot prove which internal whites the raw
    // supplier removed. Keep both source/candidate; do not guess or repurchase.
    if (!rawUrl && parent.receipt.badgeProtection && job.receipt.protection?.background?.scope === 'all-background') throw new Error('旧结果已恢复徽章内部，缺少供应商原始遮罩；无法证明全去底范围，候选保留待核对');
    const checked = await checkedProviderOutput(bytes, job, { ...services, inspectWatermarks: async () => parent!.receipt.excludedWatermarks ?? [] });
    job.url = inline(checked); job.status = 'completed'; job.error = undefined;
    job.receipt.outputSha256 = sha(checked); job.receipt.completedAt = new Date().toISOString();
  } catch (error) { job.status = 'failed'; job.error = errorText(error); }
  job.phase = 'finished'; await saveCutoutJob(job); return publicResult(job, true);
}

async function finishVolcanoCutout(job: StoredCutout, services: CutoutServices): Promise<ArtworkCutoutResult> {
  let bytes: Buffer;
  try { bytes = await services.volcanoDownload(job.providerResultUrl!); }
  catch (error) { return { ...publicResult(job), error: `火山结果下载暂未完成：${errorText(error)}；继续查询同一任务，不重新抠图` }; }
  try { bytes = await checkedProviderOutput(bytes, job, services); }
  catch (error) {
    job.status = 'failed'; job.phase = 'finished'; job.error = `火山抠图结果未通过检查：${errorText(error)}；原图已保留，可查看原图或手动选择其他方式`;
    await saveCutoutJob(job); return publicResult(job);
  }
  job.url = inline(bytes); job.status = 'completed'; job.phase = 'finished'; job.error = undefined;
  job.receipt.completedAt = new Date().toISOString(); job.receipt.outputSha256 = sha(bytes);
  await saveCutoutJob(job); return publicResult(job);
}

export async function queryArtworkCutout(key: string, services: CutoutServices = cutoutServices): Promise<ArtworkCutoutResult> {
  const job = await readCutoutJob(key);
  if (!job) throw new Error('找不到抠图任务，请核对任务记录');
  if (job.phase === 'finished') {
    if (job.receipt.route === 'meitu' && job.receipt.actualCredits === null && job.receipt.taskId) {
      try {
        const task = await services.query(job.receipt.taskId);
        const trace = task.data?.result?.parameters?.result?.submit_body?.parameter?.trace_id?.split('::')[0] || job.requestId;
        const credits = await services.credits(trace);
        if (credits !== null) { job.receipt.actualCredits = credits; await saveCutoutJob(job); }
      } catch { /* Billing can lag completion; unknown is not zero. */ }
    }
    return publicResult(job);
  }
  if (job.receipt.localValidationOnly) return finishLocalValidation(job, services);
  if (job.receipt.route === 'volcano' && job.providerResultUrl) return finishVolcanoCutout(job, services);
  if (!job.receipt.taskId) {
    if (Date.now() - Date.parse(job.updatedAt) > 180000) return { ...publicResult(job), status: 'unknown', error: '提交结果待核实，请保留任务编号联系支持；不会自动重新提交。' };
    return publicResult(job);
  }
  try {
    const response = await services.query(job.receipt.taskId);
    if (response.code || response.error_code) return { ...publicResult(job), error: response.message || '查询暂不可用，可继续查询同一任务' };
    const status = response.data?.status;
    if (status === 10) {
      const url = response.data?.result?.media_info_list?.[0]?.media_data;
      if (!url) throw new Error('美图任务完成但缺少图片地址，继续查询本次任务');
      let bytes: Buffer = await services.download(url);
      try { bytes = await checkedProviderOutput(bytes, job, services); }
      catch (error) { job.status = 'failed'; job.error = `美图结果未通过图案检查：${errorText(error)}`; job.phase = 'finished'; await saveCutoutJob(job); return publicResult(job); }
      job.url = inline(bytes); job.status = 'completed'; job.phase = 'finished'; job.error = undefined;
      job.receipt.outputSha256 = sha(bytes); job.receipt.completedAt = new Date().toISOString();
      const trace = response.data?.result?.parameters?.result?.submit_body?.parameter?.trace_id?.split('::')[0] || job.requestId;
      job.receipt.actualCredits = await services.credits(trace).catch(() => null);
      await saveCutoutJob(job);
    } else if (status === 2 || (typeof status === 'number' && status < 0)) {
      job.status = 'failed'; job.phase = 'finished'; job.error = response.message || '美图任务处理失败，原图已保留'; await saveCutoutJob(job);
    }
    return publicResult(job);
  } catch (error) { return { ...publicResult(job), error: `查询或下载暂未完成：${errorText(error)}；继续查询同一任务` }; }
}

export async function startArtworkCutout(source: Buffer, mode: ArtworkCutoutMode = 'auto', options: { retryOf?: string; services?: CutoutServices; protection?: ArtworkProtectionPolicy } = {}): Promise<ArtworkCutoutResult> {
  if (!['auto', 'standard', 'meitu'].includes(mode)) throw new Error('不支持的抠图方式');
  await assertCutoutStoreReady();
  const services = options.services ?? cutoutServices;
  const bytes = await sharp(source, { limitInputPixels: 25_000_000 }).rotate().png().toBuffer();
  const sourceSha256 = sha(bytes);
  const previous = options.retryOf ? await readCutoutJob(options.retryOf) : null;
  if (options.retryOf && (!previous || previous.status !== 'failed' || previous.receipt.sourceSha256 !== sourceSha256)) throw new Error('只有已明确失败的同图任务可以重试；处理中的任务请继续查询');
  const baseKey = sha(JSON.stringify([productionStateKey(), sha(process.env.MEITU_OPENAPI_ACCESS_KEY || 'unconfigured'), sha(process.env.MEDIAKIT_API_KEY || 'unconfigured'), MEITU_CUTOUT_VERSION, ARTWORK_CUTOUT_VERSION, mode, sourceSha256, previous?.requestId ?? '']));
  const protection = options.protection?.keepRedPanels || options.protection?.background ? options.protection : undefined;
  // New submissions share the original base key even when local policy differs.
  // Also read the historical explicit-red key so upgrading cannot repurchase it.
  const legacyRedKey = sha(JSON.stringify([baseKey, { version: 'explicit-panel-protection-v1', keepRedPanels: true }]));
  const key = baseKey;
  const found = await readCutoutJob(key) ?? await readCutoutJob(legacyRedKey);
  // A new user-requested processing run may retry a proven local failure. Keep
  // the old job for audit and use the existing retry key to deduplicate clicks.
  // Queries and uncertain/paid failures never enter this branch.
  if (found?.status === 'failed' && found.submissionNotStarted && !options.retryOf) {
    return startArtworkCutout(source, mode, { ...options, retryOf: found.receipt.jobKey });
  }
  if (found) {
    if (!samePolicy(found.receipt.protection, protection) || found.receipt.localValidationVersion !== ARTWORK_INTEGRITY_VERSION) return localValidationResult(found, protection, services);
    return found.status === 'completed' ? publicResult(found, true) : queryArtworkCutout(found.receipt.jobKey, services);
  }
  const decision = await analyzeArtworkCutout(bytes, mode, protection);
  const job: StoredCutout = { status: 'pending', phase: 'ready', requestId: randomUUID(), updatedAt: new Date().toISOString(), receipt: {
    ...decision, localValidationVersion: ARTWORK_INTEGRITY_VERSION, jobKey: key, mode, sourceSha256, sourceUrl: inline(bytes), ...(protection ? { protection } : {}), actualCredits: decision.route === 'meitu' || decision.route === 'volcano' ? null : 0, cacheHit: false,
  } };
  if (!await claimCutoutJob(job)) {
    const claimed = await readCutoutJob(key);
    if (claimed && (!samePolicy(claimed.receipt.protection, protection) || claimed.receipt.localValidationVersion !== ARTWORK_INTEGRITY_VERSION)) {
      return localValidationResult(claimed, protection, services);
    }
    return queryArtworkCutout(key, services);
  }
  if (decision.route === 'reuse' || decision.route === 'standard') {
    try {
      const profile = await inspectArtworkSource(bytes);
      const initial = decision.route === 'reuse' ? bytes : profile.backgroundColor ? await removeFlatArtworkBackground(bytes, profile.backgroundColor) : null;
      if (!initial) throw new Error('标准抠图无法确定背景颜色');
      const result = await checkedProviderOutput(initial, job, services);
      job.url = inline(result); job.status = 'completed'; job.phase = 'finished';
      job.receipt.completedAt = new Date().toISOString(); job.receipt.outputSha256 = sha(result);
      await saveCutoutJob(job); return publicResult(job);
    } catch (error) {
      if (decision.route === 'reuse') { job.status = 'failed'; job.phase = 'finished'; job.error = errorText(error); await saveCutoutJob(job); return publicResult(job); }
      job.receipt = { ...job.receipt, route: 'volcano', estimatedCredits: null, actualCredits: null, reasons: [...job.receipt.reasons, `本地去底未通过检查，使用原图调用火山一次：${errorText(error)}`] };
      await saveCutoutJob(job);
    }
  }
  if (job.receipt.route === 'volcano') {
    try {
      job.providerResultUrl = await services.volcano(bytes, { scene: 'product', crop: false, beforeSubmit: async () => { job.phase = 'submitting'; await saveCutoutJob(job); } });
      job.phase = 'submitted'; await saveCutoutJob(job);
    } catch (error) {
      job.status = job.phase === 'ready' ? 'failed' : 'unknown';
      if (job.status === 'failed') job.phase = 'finished';
      job.error = `火山抠图${job.status === 'unknown' ? '提交结果待核实，不会自动重提' : '未能开始，原图已保留'}：${errorText(error)}`;
      await saveCutoutJob(job); return publicResult(job);
    }
    return finishVolcanoCutout(job, services);
  }
  try {
    const uploaded = await services.upload(bytes);
    job.phase = 'submitting'; await saveCutoutJob(job);
    const result = await services.submit(uploaded, job.requestId);
    if (result.code || result.error_code) { const uncertain = [90009, 10002, 599, 500, 502, 503, 504].includes(result.code || result.error_code || 0); job.status = uncertain ? 'unknown' : 'failed'; if (!uncertain) job.phase = 'finished'; job.error = `美图抠图${uncertain ? '提交待核实' : '失败'}（${result.code || result.error_code}）：${result.message || '服务暂不可用'}`; }
    else if (result.data?.task_id) { job.receipt.taskId = result.data.task_id; job.phase = 'submitted'; }
    else { job.status = 'unknown'; job.error = '美图提交未返回任务编号，结果待核实；不会自动重新提交'; }
    await saveCutoutJob(job);
  } catch (error) {
    const notSubmitted = job.phase === 'ready' || error instanceof MeituSubmissionNotStartedError;
    job.status = notSubmitted ? 'failed' : 'unknown';
    job.submissionNotStarted = notSubmitted;
    if (notSubmitted) job.receipt.actualCredits = 0;
    if (job.status === 'failed') job.phase = 'finished';
    job.error = `${errorText(error)}；${job.status === 'unknown' ? '提交结果待核实，不会自动重提' : '原图已保留'}`;
    await saveCutoutJob(job);
  }
  return publicResult(job);
}

export class ArtworkCutoutPendingError extends Error {
  constructor(public result: ArtworkCutoutResult) { super(result.error || '抠图仍在处理中，可继续查询本次任务'); }
}
export async function cutoutArtworkForPipeline(bytes: Buffer, mode: ArtworkCutoutMode = 'auto', protection?: ArtworkProtectionPolicy): Promise<{ bytes: Buffer; receipt: ArtworkCutoutReceipt }> {
  const applied = protection?.keepRedPanels || protection?.background ? protection : undefined;
  const requested = currentCutoutRecovery();
  const sourceHash = requested ? sha(await sharp(bytes, { limitInputPixels: 25_000_000 }).rotate().png().toBuffer()) : null;
  const recovery = requested?.sourceSha256 === sourceHash ? requested : undefined;
  const actualMode = recovery?.mode ?? mode;
  const replay = await artworkJobStep('cutout', 'cutout', { bytes, mode: actualMode, ...(applied ? { protection: applied } : {}),
    ...(recovery ? { retryOf: recovery.failedKey } : {}) }, () => pipelineCutout(bytes, actualMode, applied, recovery?.failedKey));
  // This is outside the durable checkpoint: old cached 'passed' results must
  // not bypass new local integrity checks. No new provider call occurs here.
  try {
    const checked = await validateCutoutOutput(replay.bytes, await sharp(bytes).rotate().png().toBuffer(), { protection: applied,
      inspectWatermarks: async () => replay.receipt.excludedWatermarks ?? [] });
    replay.receipt = { ...replay.receipt, integrityCheck: checked.integrity };
  } catch (error) {
    const stored = await readCutoutJob(replay.receipt.jobKey);
    if (stored && !stored.receipt.localValidationOnly) {
      const checked = await localValidationResult(stored, applied, cutoutServices);
      if (checked.status === 'completed' && checked.url) return { bytes: Buffer.from(checked.url.split(',')[1], 'base64'), receipt: checked.receipt };
      throw new ArtworkCutoutPendingError(checked);
    }
    const meta = await sharp(replay.bytes).metadata();
    throw new ArtworkCutoutPendingError({ status: 'failed', receipt: replay.receipt, error: errorText(error), candidate: {
      url: inline(replay.bytes), width: meta.width!, height: meta.height!, missingRegions: error instanceof ArtworkCutoutContentError ? error.missingRegions : [] } });
  }
  return replay;
}
async function pipelineCutout(bytes: Buffer, mode: ArtworkCutoutMode, protection?: ArtworkProtectionPolicy, retryOf?: string) {
  let result = await startArtworkCutout(bytes, mode, { protection, retryOf });
  const deadline = Date.now() + 60000;
  while (result.status === 'pending' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    result = await queryArtworkCutout(result.receipt.jobKey);
  }
  if (result.status !== 'completed' || !result.url) throw new ArtworkCutoutPendingError(result);
  return { bytes: Buffer.from(result.url.split(',')[1], 'base64'), receipt: result.receipt };
}
