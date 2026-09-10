import { productionUser, usesProductionCloud, persistProductionReferences } from '@/lib/server/production-storage';
import { after, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { prepareStandardArtwork, NativeArtworkCandidateError } from '@/lib/server/artwork-standard-pipeline';
import { CliproxyImageConfigurationError } from '@/lib/server/cliproxy-image-2';
import { parseArtworkPreparationRequest } from '@/lib/task-review-artwork';
import { ArtworkCutoutPendingError } from '@/lib/server/artwork-cutout';
import { assertCutoutStoreReady } from '@/lib/server/artwork-cutout-store';
import type { ArtworkFailure, ArtworkProgressEvent, ArtworkStreamEvent } from '@/lib/artwork-progress';
import type { ArtworkPreparationRequest } from '@/lib/task-review-artwork';
import { artworkNetworkFailure } from '@/lib/server/artwork-network-error';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_REQUEST_BYTES = 13 * 1024 * 1024;
type FailureContext = { requestId: string; failedStages: Set<string> };
const stageLabels: Record<string, string> = {
  sourceQuality: '检查原图清晰度', resultQuality: '检查成品清晰度', generation: '生成图案',
  cutout: '去除背景', fidelity: '修复原图', inspection: '检查原图内容',
  referenceColor: '读取参考图颜色', editVerification: '检查修改结果', filePersistence: '保存生成文件',
};

async function failure(error: unknown, context: FailureContext): Promise<{ body: ArtworkFailure; status: number }> {
  const stages = [...context.failedStages].map(stage => stageLabels[stage] ?? '图案处理');
  const network = artworkNetworkFailure(error, stages.join('、') || '图案处理');
  if (network) console.error('[artwork] network failure', {
    requestId: context.requestId, stage: network.stage, failedStages: [...context.failedStages], codes: network.codes,
  });
  const body = error instanceof ArtworkCutoutPendingError ? { error: error.message, cutout: error.result }
    : error instanceof NativeArtworkCandidateError ? { error: error.message, candidate: error.candidate } : null;
  if (body) {
    try { return { body: usesProductionCloud() ? await persistProductionReferences(body) : body, status: 422 }; }
    catch (storageError) {
      const cutout = 'cutout' in body ? body.cutout : body.candidate?.cutout;
      console.error('[artwork] failure attachment persistence failed', {
        jobKey: cutout?.receipt.jobKey,
        name: storageError instanceof Error ? storageError.name : 'UnknownError',
        code: storageError && typeof storageError === 'object' && 'code' in storageError ? storageError.code : undefined,
      });
      // Return the original receipt and inline candidate so the client can keep
      // its recovery bookmark even when the secondary attachment save fails.
      return { body: { ...body, error: `${body.error}；错误记录附件暂未保存到云端，请保留当前页面${cutout ? `，任务编号：${cutout.receipt.jobKey}` : ''}。` }, status: 502 };
    }
  }
  const message = network ? `${network.message}请保留当前页面，先核对已有结果或任务进度。排查编号：${context.requestId}`
    : error instanceof Error ? error.message : String(error);
  const configurationError = message.startsWith('抠图服务尚未启用') || error instanceof CliproxyImageConfigurationError || message.includes('MEDIAKIT_API_KEY is not configured')
    || message.includes('ARK_RUNTIME_API_KEY or ARK_API_KEY is not configured');
  const inputError = ['generationPrompt', '生图提示词', '请先整理生图提示词', '图案准备请求', '页面', '先补齐', '方案类型', '特殊文字单次', 'sourceRequirementText', 'instruction', 'image', 'exactText', 'layoutNote', 'enhancementMode', 'sourceScope', 'processingRoute', 'expectedPromptVersion', 'expectedPromptHash', 'primaryImageLabel', 'referenceImages']
    .some((prefix) => message.startsWith(prefix));
  return { body: { error: message }, status: configurationError ? 503 : inputError ? 400 : 502 };
}

async function prepare(input: ArtworkPreparationRequest, context: FailureContext, notify?: (event: ArtworkProgressEvent) => void) {
  const started = performance.now();
  const progress = (event: ArtworkProgressEvent) => {
    if (event.type === 'timing' && event.timing.status === 'failed') context.failedStages.add(event.timing.stage);
    notify?.(event);
  };
  const result = await prepareStandardArtwork(input, undefined, progress);
  const saving = performance.now();
  const stored = usesProductionCloud() ? await persistProductionReferences(result).catch(error => {
    context.failedStages.add('filePersistence'); throw error;
  }) : result;
  const timing = { stage: 'filePersistence', startMs: Math.round(saving - started), durationMs: Math.round(performance.now() - saving), status: 'completed' as const };
  stored.preprocessing.timings = [...(stored.preprocessing.timings ?? []), timing];
  notify?.({ type: 'timing', timing });
  return stored;
}

function streamingPreparation(input: ArtworkPreparationRequest, context: FailureContext) {
  const encoder = new TextEncoder();
  let connected = true;
  let work!: Promise<void>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ArtworkStreamEvent) => {
        if (!connected) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { connected = false; }
      };
      const heartbeat = setInterval(() => send({ type: 'ping' }), 15_000);
      work = (async () => {
        try { send({ type: 'complete', result: await prepare(input, context, send) }); }
        catch (error) {
          const rejected = await failure(error, context); send({ type: 'error', status: rejected.status, ...rejected.body });
        } finally {
          clearInterval(heartbeat);
          if (connected) controller.close();
        }
      })();
    },
    cancel() { connected = false; },
  });
  // Keep an already submitted paid call and its original-file receipt alive on disconnect.
  after(work);
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

export async function POST(request: Request) {
  const context: FailureContext = { requestId: randomUUID(), failedStages: new Set() };
  try {
    await productionUser(request, true);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_REQUEST_BYTES) throw new Error(`图案准备请求不能超过 13MB，实际 ${contentLength}B`);
    const input = parseArtworkPreparationRequest(await request.json());
    await assertCutoutStoreReady();
    if (request.headers.get('accept')?.includes('application/x-ndjson')) return streamingPreparation(input, context);
    return NextResponse.json(await prepare(input, context));
  } catch (error) {
    const rejected = await failure(error, context);
    return NextResponse.json(rejected.body, { status: rejected.status });
  }
}
