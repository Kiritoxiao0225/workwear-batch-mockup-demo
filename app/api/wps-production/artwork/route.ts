import { productionUser, usesProductionCloud, persistProductionReferences } from '@/lib/server/production-storage';
import { after, NextResponse } from 'next/server';

import { prepareStandardArtwork, NativeArtworkCandidateError } from '@/lib/server/artwork-standard-pipeline';
import { CliproxyImageConfigurationError } from '@/lib/server/cliproxy-image-2';
import { parseArtworkPreparationRequest } from '@/lib/task-review-artwork';
import { ArtworkCutoutPendingError } from '@/lib/server/artwork-cutout';
import { assertCutoutStoreReady } from '@/lib/server/artwork-cutout-store';
import type { ArtworkFailure, ArtworkProgressEvent, ArtworkStreamEvent } from '@/lib/artwork-progress';
import type { ArtworkPreparationRequest } from '@/lib/task-review-artwork';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_REQUEST_BYTES = 13 * 1024 * 1024;

async function failure(error: unknown): Promise<{ body: ArtworkFailure; status: number }> {
  const body = error instanceof ArtworkCutoutPendingError ? { error: error.message, cutout: error.result }
    : error instanceof NativeArtworkCandidateError ? { error: error.message, candidate: error.candidate } : null;
  if (body) return { body: usesProductionCloud() ? await persistProductionReferences(body) : body, status: 422 };
  const message = error instanceof Error ? error.message : String(error);
  const configurationError = message.startsWith('抠图服务尚未启用') || error instanceof CliproxyImageConfigurationError || message.includes('MEDIAKIT_API_KEY is not configured')
    || message.includes('ARK_RUNTIME_API_KEY or ARK_API_KEY is not configured');
  const inputError = ['generationPrompt', '生图提示词', '请先整理生图提示词', '图案准备请求', '页面', '先补齐', '方案类型', '特殊文字单次', 'sourceRequirementText', 'instruction', 'image', 'exactText', 'layoutNote', 'enhancementMode', 'sourceScope', 'processingRoute', 'expectedPromptVersion', 'expectedPromptHash', 'primaryImageLabel', 'referenceImages']
    .some((prefix) => message.startsWith(prefix));
  return { body: { error: message }, status: configurationError ? 503 : inputError ? 400 : 502 };
}

async function prepare(input: ArtworkPreparationRequest, notify?: (event: ArtworkProgressEvent) => void) {
  const started = performance.now();
  const result = await prepareStandardArtwork(input, undefined, notify);
  const saving = performance.now();
  const stored = usesProductionCloud() ? await persistProductionReferences(result) : result;
  const timing = { stage: 'filePersistence', startMs: Math.round(saving - started), durationMs: Math.round(performance.now() - saving), status: 'completed' as const };
  stored.preprocessing.timings = [...(stored.preprocessing.timings ?? []), timing];
  notify?.({ type: 'timing', timing });
  return stored;
}

function streamingPreparation(input: ArtworkPreparationRequest) {
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
        try { send({ type: 'complete', result: await prepare(input, send) }); }
        catch (error) {
          try { const rejected = await failure(error); send({ type: 'error', status: rejected.status, ...rejected.body }); }
          catch { send({ type: 'error', status: 502, error: '图案文件保存未完成，请保留当前页面并核对任务记录。' }); }
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
  try {
    await productionUser(request, true);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_REQUEST_BYTES) throw new Error(`图案准备请求不能超过 13MB，实际 ${contentLength}B`);
    const input = parseArtworkPreparationRequest(await request.json());
    await assertCutoutStoreReady();
    if (request.headers.get('accept')?.includes('application/x-ndjson')) return streamingPreparation(input);
    return NextResponse.json(await prepare(input));
  } catch (error) {
    const rejected = await failure(error);
    return NextResponse.json(rejected.body, { status: rejected.status });
  }
}
