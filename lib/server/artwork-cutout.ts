import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { ArtworkCutoutMode, ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { ARTWORK_CUTOUT_VERSION } from '@/lib/artwork-cutout';
import { analyzeArtworkCutout, validateCutoutOutput } from './artwork-cutout-analysis';
import { inspectArtworkSource, removeFlatArtworkBackground } from './artwork-image-processing';
import { assertCutoutStoreReady, readCutoutJob, claimCutoutJob, saveCutoutJob, type StoredCutout } from './artwork-cutout-store';
import { MEITU_CUTOUT_VERSION, MeituSubmissionNotStartedError, uploadMeituCutoutInput, submitMeituCutout, queryMeituCutout, downloadMeituCutout, meituCutoutCredits } from './meitu-cutout';
import { productionStateKey } from './production-storage';
import { submitArtworkBackgroundRemoval, downloadArtworkBackgroundRemoval } from './media-kit-artwork';
import { protectArtworkBadges } from './artwork-badge-protection';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const inline = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
export const cutoutServices = { upload: uploadMeituCutoutInput, submit: submitMeituCutout, query: queryMeituCutout, download: downloadMeituCutout, credits: meituCutoutCredits,
  volcano: submitArtworkBackgroundRemoval, volcanoDownload: downloadArtworkBackgroundRemoval };
export type CutoutServices = typeof cutoutServices;
function publicResult(job: StoredCutout, cacheHit = false): ArtworkCutoutResult { return { status: job.status, url: job.url, error: job.error, receipt: { ...job.receipt, cacheHit } }; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

async function checkedProviderOutput(bytes: Buffer, job: StoredCutout) {
  await validateCutoutOutput(bytes);
  const source = Buffer.from(job.receipt.sourceUrl.split(',')[1], 'base64');
  const protectedResult = await protectArtworkBadges(source, bytes);
  await validateCutoutOutput(protectedResult.bytes, source);
  if (protectedResult.regions.length) {
    job.receipt.badgeProtection = { regions: protectedResult.regions.length, restoredPixels: protectedResult.restoredPixels };
    const reason = `已保护 ${protectedResult.regions.length} 个圆形徽章，圆内使用原图像素，保留底色与白色图形`;
    if (!job.receipt.reasons.includes(reason)) job.receipt.reasons.push(reason);
  }
  return protectedResult.bytes;
}

async function finishVolcanoCutout(job: StoredCutout, services: CutoutServices): Promise<ArtworkCutoutResult> {
  let bytes: Buffer;
  try { bytes = await services.volcanoDownload(job.providerResultUrl!); }
  catch (error) { return { ...publicResult(job), error: `火山结果下载暂未完成：${errorText(error)}；继续查询同一任务，不重新抠图` }; }
  try { bytes = await checkedProviderOutput(bytes, job); }
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
      try { bytes = await checkedProviderOutput(bytes, job); }
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

export async function startArtworkCutout(source: Buffer, mode: ArtworkCutoutMode = 'auto', options: { retryOf?: string; services?: CutoutServices } = {}): Promise<ArtworkCutoutResult> {
  if (!['auto', 'standard', 'meitu'].includes(mode)) throw new Error('不支持的抠图方式');
  await assertCutoutStoreReady();
  const services = options.services ?? cutoutServices;
  const bytes = await sharp(source, { limitInputPixels: 25_000_000 }).rotate().png().toBuffer();
  const sourceSha256 = sha(bytes);
  const previous = options.retryOf ? await readCutoutJob(options.retryOf) : null;
  if (options.retryOf && (!previous || previous.status !== 'failed' || previous.receipt.sourceSha256 !== sourceSha256)) throw new Error('只有已明确失败的同图任务可以重试；处理中的任务请继续查询');
  const key = sha(JSON.stringify([productionStateKey(), sha(process.env.MEITU_OPENAPI_ACCESS_KEY || 'unconfigured'), sha(process.env.MEDIAKIT_API_KEY || 'unconfigured'), MEITU_CUTOUT_VERSION, ARTWORK_CUTOUT_VERSION, mode, sourceSha256, previous?.requestId ?? '']));
  const found = await readCutoutJob(key);
  // A new user-requested processing run may retry a proven local failure. Keep
  // the old job for audit and use the existing retry key to deduplicate clicks.
  // Queries and uncertain/paid failures never enter this branch.
  if (found?.status === 'failed' && found.submissionNotStarted && !options.retryOf) {
    return startArtworkCutout(source, mode, { ...options, retryOf: key });
  }
  if (found) return found.status === 'completed' ? publicResult(found, true) : queryArtworkCutout(key, services);
  const decision = await analyzeArtworkCutout(bytes, mode);
  const job: StoredCutout = { status: 'pending', phase: 'ready', requestId: randomUUID(), updatedAt: new Date().toISOString(), receipt: {
    ...decision, jobKey: key, mode, sourceSha256, sourceUrl: inline(bytes), actualCredits: decision.route === 'meitu' || decision.route === 'volcano' ? null : 0, cacheHit: false,
  } };
  if (!await claimCutoutJob(job)) return queryArtworkCutout(key, services);
  if (decision.route === 'reuse' || decision.route === 'standard') {
    try {
      const profile = await inspectArtworkSource(bytes);
      const result = decision.route === 'reuse' ? bytes : profile.backgroundColor ? await removeFlatArtworkBackground(bytes, profile.backgroundColor) : null;
      if (!result) throw new Error('标准抠图无法确定背景颜色');
      await validateCutoutOutput(result);
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
export async function cutoutArtworkForPipeline(bytes: Buffer, mode: ArtworkCutoutMode = 'auto') {
  let result = await startArtworkCutout(bytes, mode);
  const deadline = Date.now() + 60000;
  while (result.status === 'pending' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    result = await queryArtworkCutout(result.receipt.jobKey);
  }
  if (result.status !== 'completed' || !result.url) throw new ArtworkCutoutPendingError(result);
  return { bytes: Buffer.from(result.url.split(',')[1], 'base64'), receipt: result.receipt };
}
