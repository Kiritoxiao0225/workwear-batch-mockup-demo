'use client';
import { useEffect, useRef, useState } from 'react';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { WpsProductionState } from '@/lib/wps-production';
import { canAnalyzeWpsTask, pendingWpsAnalysisRecords, wpsSourceEvidence } from '@/lib/wps-source';
import { runTaskReviewAnalysisBatch } from '@/lib/client/task-review-analysis-batch';
import { readWpsAnalysisResponse, WpsAnalysisResponseError } from '@/lib/client/wps-analysis-response';
import { WPS_ANALYSIS_CLIENT_TIMEOUT_MS, type WpsAnalysisResult, type WpsAnalysisStage, type WpsAnalysisTiming } from '@/lib/wps-analysis-progress';

export type WpsAnalysisStatus = {
  phase: 'queued' | 'analyzing' | 'saving' | 'failed';
  error?: string;
  parsed?: boolean;
  stage?: WpsAnalysisStage;
  timings?: WpsAnalysisTiming[];
  requestId?: string;
};

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  return body as T;
}

/** A source revision is attempted once per page session; failed entries require explicit retry. */
export function useWpsAutomaticAnalysis(state: WpsProductionState | null, enabled: boolean, accept: (state: WpsProductionState) => void) {
  const attempted = useRef(new Set<string>()), running = useRef(false);
  const parsed = useRef(new Map<string, WpsAnalysisResult>());
  const currentSources = useRef<SourceTaskRecord[]>([]);
  const [progress, setProgress] = useState({ running: false, completed: 0, total: 0 });
  const [statuses, setStatuses] = useState<Record<string, WpsAnalysisStatus>>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => { currentSources.current = state?.records.map(record => record.source) ?? []; }, [state]);
  useEffect(() => {
    if (!enabled || !state || running.current) return;
    const pending = pendingWpsAnalysisRecords(state.records).map(record => record.source).filter(source => !attempted.current.has(wpsSourceEvidence(source)));
    if (!pending.length) return;
    pending.forEach(source => attempted.current.add(wpsSourceEvidence(source)));
    setStatuses(current => ({ ...current, ...Object.fromEntries(pending.map(source => [wpsSourceEvidence(source), { phase: 'queued' as const }])) }));
    running.current = true;
    setProgress({ running: true, completed: 0, total: pending.length });
    const assertCurrentSource = (source: SourceTaskRecord) => {
      const current = currentSources.current.find(item => item.recordId === source.recordId);
      if (!current || !canAnalyzeWpsTask(current) || wpsSourceEvidence(current) !== wpsSourceEvidence(source)) throw new Error('需求或任务状态已变化，本次解析结果未保存');
    };
    void runTaskReviewAnalysisBatch(pending, async source => {
      assertCurrentSource(source);
      const key = wpsSourceEvidence(source);
      if (parsed.current.has(key)) {
        setStatuses(current => ({ ...current, [key]: { phase: 'saving' } }));
        return parsed.current.get(key)!;
      }
      setStatuses(current => ({ ...current, [key]: { phase: 'analyzing' } }));
      const result = await readWpsAnalysisResponse(await fetch('/api/wps-production/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ records: [source] }), signal: AbortSignal.timeout(WPS_ANALYSIS_CLIENT_TIMEOUT_MS),
      }), event => setStatuses(current => ({ ...current, [key]: { ...current[key], phase: 'analyzing',
        ...(event.type === 'stage' ? { stage: event.stage } : { timings: [...(current[key]?.timings ?? []), event.timing] }),
      } })));
      if (!result.reviews?.some(review => review.source.recordId === source.recordId && review.units.length > 0)) throw new Error('未解析出可制作的印花位置，请检查需求后重试');
      parsed.current.set(key, result);
      setStatuses(current => ({ ...current, [key]: { ...current[key], phase: 'saving', requestId: result.requestId } }));
      return result;
    }, async (result, source) => {
      const savingAt = Date.now();
      const savedTiming = () => console.info('[wps-analysis-save]', { requestId: result.requestId, durationMs: Date.now() - savingAt });
      setStatuses(current => ({ ...current, [wpsSourceEvidence(source)]: { ...current[wpsSourceEvidence(source)], phase: 'saving' } }));
      // Other rows may save while the model runs. Retry only the commit, never the model.
      for (let attempt = 0; attempt < 3; attempt++) {
        assertCurrentSource(source);
        const latest = await json<WpsProductionState>(await fetch('/api/wps-production', { cache: 'no-store', signal: AbortSignal.timeout(60_000) }));
        const alreadySaved = latest.records.find(record => record.source.recordId === source.recordId && wpsSourceEvidence(record.source) === wpsSourceEvidence(source) && record.unitIds.length);
        if (alreadySaved) { accept(latest); savedTiming(); return; }
        try {
          const saved = await json<WpsProductionState>(await fetch('/api/wps-production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
            body: JSON.stringify({ action: 'upsertReviews', expectedRevision: latest.revision, reviews: result.reviews }) }));
          accept(saved); savedTiming(); return;
        } catch (error) {
          if (attempt === 2 || !(error instanceof Error) || !('status' in error) || error.status !== 409) throw error;
        }
      }
    }, (source, error) => {
      const key = wpsSourceEvidence(source);
      if (!error) parsed.current.delete(key);
      const hasParsed = parsed.current.has(key);
      setStatuses(current => {
        const next = { ...current };
        if (error) next[key] = { ...current[key], phase: 'failed',
          error: error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? hasParsed ? '保存请求超时；重试保存时会先核对是否已成功保存' : '解析请求等待超时，请重试解析'
            : error instanceof Error ? error.message : String(error), parsed: hasParsed,
          ...(error instanceof WpsAnalysisResponseError ? { stage: error.failure.stage, timings: error.failure.timings ?? current[key]?.timings, requestId: error.failure.requestId } : {}),
        };
        else delete next[key];
        return next;
      });
      setProgress(current => ({ ...current, completed: current.completed + 1 }));
    }).finally(() => {
      running.current = false;
      setProgress(current => ({ ...current, running: false }));
      setRetry(current => current + 1);
    });
  }, [state, enabled, accept, retry]);
  const pendingSources = pendingWpsAnalysisRecords(state?.records ?? []).map(record => record.source);
  const failedSources = pendingSources.filter(source => statuses[wpsSourceEvidence(source)]?.phase === 'failed');
  return {
    ...progress,
    enabled,
    statuses: Object.fromEntries(pendingSources.map(source => [source.recordId, statuses[wpsSourceEvidence(source)]])),
    errors: failedSources.map(source => `${source.customerId}：${statuses[wpsSourceEvidence(source)].error}`),
    retryFailed: (source?: SourceTaskRecord) => {
      const keys = failedSources.filter(failed => !source || wpsSourceEvidence(failed) === wpsSourceEvidence(source)).map(wpsSourceEvidence);
      keys.forEach(key => attempted.current.delete(key));
      setStatuses(current => {
        const next = { ...current };
        keys.forEach(key => { next[key] = { phase: 'queued' }; });
        return next;
      });
      setRetry(current => current + 1);
    },
  };
}
