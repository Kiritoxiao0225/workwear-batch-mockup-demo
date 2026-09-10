import { wpsAnalysisSnapshot } from '@/lib/wps-analysis-snapshot';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { after, NextResponse } from 'next/server';

import type { SourceTaskRecord } from '@/lib/batch-task-review';
import { analyzeSourceTaskRecords } from '@/lib/server/ark-task-review';
import { listWpsSourceTaskRecords } from '@/lib/server/wps-dbsheet';
import { canAnalyzeWpsTask, wpsSourceEvidence } from '@/lib/wps-source';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { WpsAnalysisTrace } from '@/lib/server/wps-analysis-trace';
import { WPS_ANALYSIS_REQUEST_TIMEOUT_MS, WPS_ANALYSIS_STAGE_LABELS, type WpsAnalysisFailure, type WpsAnalysisStreamEvent } from '@/lib/wps-analysis-progress';

export const runtime = 'nodejs';
export const maxDuration = 300;

function parsedRecords(value: unknown): SourceTaskRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是对象');
  const records = (value as Record<string, unknown>).records;
  if (!Array.isArray(records) || records.length === 0) throw new Error('records 必须是非空数组');
  if (records.length > 30) throw new Error(`单次最多分析 30 条记录，实际 ${records.length}`);
  return records.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`records[${index}] 必须是对象`);
    const record = entry as Record<string, unknown>;
    for (const field of ['recordId', 'customerId', 'revision', 'requirementText', 'productStyleText']) {
      if (typeof record[field] !== 'string' || !record[field].trim()) throw new Error(`records[${index}].${field} 必须是非空字符串`);
    }
    if (!Array.isArray(record.materials)) throw new Error(`records[${index}].materials 必须是数组`);
    return entry as SourceTaskRecord;
  });
}

async function analyze(records: SourceTaskRecord[], trace: WpsAnalysisTrace, signal: AbortSignal) {
  signal.throwIfAborted();
  const initial = await readWpsProductionState();
  const targetSnapshots = Object.fromEntries(records.map(source => [source.recordId, wpsAnalysisSnapshot(initial, source.recordId)]));
  const verifiedRecords = await trace.measure('source', async () => {
    const { records: currentRecords } = await listWpsSourceTaskRecords({ recordIds: records.map(record => record.recordId) });
    const currentById = new Map(currentRecords.map((record) => [record.recordId, record]));
    return records.map((record) => {
      const current = currentById.get(record.recordId);
      if (!current) throw new Error(`WPS_ANALYSIS_CONFLICT: 记录 ${record.recordId} 已不存在或读取失败，请重新同步`);
      if (!canAnalyzeWpsTask(current)) throw new Error(`WPS_ANALYSIS_CONFLICT: ${record.recordId} 当前状态为“${current.wpsSource?.status ?? '未识别状态'}”，仅允许分析待领取和设计中的任务`);
      if (wpsSourceEvidence(current) !== wpsSourceEvidence(record)) throw new Error(`WPS_ANALYSIS_CONFLICT: ${record.recordId} 原文或素材已变化，请重新同步后分析`);
      return current;
    });
  });
  signal.throwIfAborted();
  return { ...await analyzeSourceTaskRecords(verifiedRecords, { trace, signal }), targetSnapshots };
}

function failure(error: unknown, trace?: WpsAnalysisTrace): WpsAnalysisFailure {
  const aborted = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
  const message = aborted ? `解析在“${WPS_ANALYSIS_STAGE_LABELS[trace?.stage ?? 'source']}”阶段超时或连接已取消，未保存不完整结果；请重试解析`
    : error instanceof Error ? error.message : String(error);
  const configurationError = message.includes('is not configured') || message.startsWith('WPS_SYNC_NOT_CONFIGURED:') || message.startsWith('WPS_ANALYSIS_CONFIG_ERROR:');
  const inputError = message.startsWith('records') || message.startsWith('请求体') || message.startsWith('单次');
  const status = error instanceof CatalogHttpError ? error.status : message.startsWith('WPS_ANALYSIS_CONFLICT:') ? 409
    : configurationError ? 503 : inputError ? 400 : aborted || message.includes('超时') ? 504 : 502;
  if (trace) console.warn('[wps-analysis]', { requestId: trace.requestId, stage: trace.stage, status, totalMs: Date.now() - trace.startedAt });
  return { error: message, status, ...(trace ? { requestId: trace.requestId, stage: trace.stage, timings: [...trace.timings] } : {}) };
}

function streamingAnalysis(records: SourceTaskRecord[], request: Request) {
  const encoder = new TextEncoder(), disconnect = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnect.signal, AbortSignal.timeout(WPS_ANALYSIS_REQUEST_TIMEOUT_MS)]);
  let connected = true;
  let work!: Promise<void>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: WpsAnalysisStreamEvent) => {
        if (!connected) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { connected = false; disconnect.abort(); }
      };
      const trace = new WpsAnalysisTrace(send);
      const heartbeat = setInterval(() => send({ type: 'ping' }), 15_000);
      work = (async () => {
        try { send({ type: 'complete', result: await analyze(records, trace, signal) }); }
        catch (error) { send({ type: 'error', ...failure(error, trace) }); }
        finally { clearInterval(heartbeat); if (connected) controller.close(); }
      })();
    },
    cancel() { connected = false; disconnect.abort(); },
  });
  after(work);
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

export async function POST(request: Request) {
  let trace: WpsAnalysisTrace | undefined;
  try {
    await productionUser(request, true);
    const records = parsedRecords(await request.json());
    if (request.headers.get('accept')?.includes('application/x-ndjson')) return streamingAnalysis(records, request);
    trace = new WpsAnalysisTrace();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(WPS_ANALYSIS_REQUEST_TIMEOUT_MS)]);
    return NextResponse.json(await analyze(records, trace, signal));
  } catch (error) {
    const body = failure(error, trace);
    return NextResponse.json(body, { status: body.status });
  }
}
