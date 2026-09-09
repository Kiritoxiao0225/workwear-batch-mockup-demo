'use client';
import { useEffect, useRef, useState } from 'react';
import type { SourceTaskRecord, TaskReview } from '@/lib/batch-task-review';
import type { WpsProductionState } from '@/lib/wps-production';
import { canAnalyzeWpsTask, pendingWpsAnalysisRecords, wpsSourceEvidence } from '@/lib/wps-source';
import { runTaskReviewAnalysisBatch } from '@/lib/client/task-review-analysis-batch';

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  return body as T;
}

/** A source revision is attempted once per page session; failed entries require explicit retry. */
export function useWpsAutomaticAnalysis(state: WpsProductionState | null, enabled: boolean, accept: (state: WpsProductionState) => void) {
  const attempted = useRef(new Set<string>()), running = useRef(false);
  const parsed = useRef(new Map<string, { reviews: TaskReview[] }>());
  const currentSources = useRef<SourceTaskRecord[]>([]);
  const [progress, setProgress] = useState({ running: false, completed: 0, total: 0 });
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => { currentSources.current = state?.records.map(record => record.source) ?? []; }, [state]);
  useEffect(() => {
    if (!enabled || !state || running.current) return;
    const pending = pendingWpsAnalysisRecords(state.records).map(record => record.source).filter(source => !attempted.current.has(wpsSourceEvidence(source)));
    if (!pending.length) return;
    pending.forEach(source => attempted.current.add(wpsSourceEvidence(source)));
    running.current = true;
    setProgress({ running: true, completed: 0, total: pending.length });
    const assertCurrentSource = (source: SourceTaskRecord) => {
      const current = currentSources.current.find(item => item.recordId === source.recordId);
      if (!current || !canAnalyzeWpsTask(current) || wpsSourceEvidence(current) !== wpsSourceEvidence(source)) throw new Error('需求或任务状态已变化，本次解析结果未保存');
    };
    void runTaskReviewAnalysisBatch(pending, async source => {
      assertCurrentSource(source);
      const key = wpsSourceEvidence(source);
      if (parsed.current.has(key)) return parsed.current.get(key)!;
      const result = await json<{ reviews: TaskReview[] }>(await fetch('/api/wps-production/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [source] }), signal: AbortSignal.timeout(180_000),
      }));
      parsed.current.set(key, result);
      return result;
    }, async (result, source) => {
      // Other rows may save while the model runs. Retry only the commit, never the model.
      for (let attempt = 0; attempt < 3; attempt++) {
        assertCurrentSource(source);
        const latest = await json<WpsProductionState>(await fetch('/api/wps-production', { cache: 'no-store' }));
        const alreadySaved = latest.records.find(record => record.source.recordId === source.recordId && wpsSourceEvidence(record.source) === wpsSourceEvidence(source) && record.unitIds.length);
        if (alreadySaved) { accept(latest); return; }
        try {
          const saved = await json<WpsProductionState>(await fetch('/api/wps-production', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upsertReviews', expectedRevision: latest.revision, reviews: result.reviews }) }));
          accept(saved); return;
        } catch (error) {
          if (attempt === 2 || !(error instanceof Error) || !('status' in error) || error.status !== 409) throw error;
        }
      }
    }, (source, error) => {
      const key = wpsSourceEvidence(source);
      if (!error) parsed.current.delete(key);
      setFailures(current => { const next = { ...current }; if (error) next[key] = `${source.customerId}：${error instanceof Error ? error.message : String(error)}`; else delete next[key]; return next; });
      setProgress(current => ({ ...current, completed: current.completed + 1 }));
    }).finally(() => {
      running.current = false;
      setProgress(current => ({ ...current, running: false }));
      setRetry(current => current + 1);
    });
  }, [state, enabled, accept, retry]);
  const activeEvidence = new Set(state?.records.filter(record => canAnalyzeWpsTask(record.source)).map(record => wpsSourceEvidence(record.source)));
  const errors = Object.entries(failures).filter(([key]) => activeEvidence.has(key));
  return { ...progress, errors: errors.map(([, message]) => message), retryFailed: () => {
    errors.forEach(([key]) => attempted.current.delete(key)); setFailures({}); setRetry(current => current + 1);
  } };
}
