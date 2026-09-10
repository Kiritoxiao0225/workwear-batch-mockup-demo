'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WpsProductionState } from '@/lib/wps-production';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import { pendingWpsAnalysisRecords, wpsSourceEvidence } from '@/lib/wps-source';
import { ConditionalJsonReader } from '@/lib/client/conditional-json';
import { artworkPollDelay } from '@/lib/artwork-polling';
import type { WpsAnalysisStatus } from './use-wps-automatic-analysis';
import type { readWpsAnalysisJobs } from '@/lib/server/wps-analysis-jobs';

type Queue = Awaited<ReturnType<typeof readWpsAnalysisJobs>>;
export function useWpsDurableAnalysis(state: WpsProductionState | null, enabled: boolean, accept: (state: WpsProductionState) => void) {
  const reader = useRef(new ConditionalJsonReader('/api/wps-production/analysis-jobs'));
  const [data, setData] = useState<Queue | null>(null), [error, setError] = useState('');
  const receiver = useRef(accept), latestData = useRef<Queue | null>(null);
  const attempted = useRef(new Set<string>()), completed = useRef(''), mounted = useRef(false);
  const flight = useRef<Promise<void> | null>(null);
  useEffect(() => { receiver.current = accept; }, [state, accept]);
  const refresh = useCallback(() => {
    if (flight.current) return flight.current;
    const work = (async () => {
      try {
        const response = await reader.current.read(AbortSignal.timeout(30_000));
        const payload: Queue = await response.json();
        if (!response.ok) throw new Error((payload as unknown as { error: string }).error || '读取后台解析失败');
        if (!mounted.current) return;
        latestData.current = payload; setData(payload); setError('');
        const saved = payload.jobs.filter(job => job.status === 'completed').map(job => job.id).sort().join(',');
        if (saved && saved !== completed.current) {
          const response = await fetch('/api/wps-production', { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error('解析已完成，读取保存结果失败，将自动重试');
          const state = await response.json();
          if (mounted.current) { receiver.current(state); completed.current = saved; }
        }
      } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    })().finally(() => { if (flight.current === work) flight.current = null; });
    flight.current = work; return work;
  }, []);
  const active = data?.jobs.some(job => ['queued', 'running', 'saving'].includes(job.status));
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return () => { mounted.current = false; };
    let stopped = false, epoch = 0, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { const own = ++epoch; clearTimeout(timer); await refresh(); if (!stopped && own === epoch) timer = setTimeout(poll, artworkPollDelay(latestData.current?.jobs ?? [], document.hidden)); };
    void poll();
    const focus = () => { if (!document.hidden) void poll(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { mounted.current = false; stopped = true; clearTimeout(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [enabled, refresh, active]);
  const submit = useCallback(async (sources: SourceTaskRecord[], retry = false) => {
    if (!sources.length) return;
    try {
      for (let offset = 0; offset < sources.length; offset += 30) {
        const records = sources.slice(offset, offset + 30).map(source => ({ recordId: source.recordId, evidence: wpsSourceEvidence(source) }));
        const response = await fetch('/api/wps-production/analysis-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records, retry }), signal: AbortSignal.timeout(60_000) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '提交后台解析失败');
        if (mounted.current) { latestData.current = payload; setData(payload); setError(payload.results?.filter((result: { error?: string }) => result.error).map((result: { error: string }) => result.error).join('；') || ''); }
      }
      reader.current.invalidate(); await refresh();
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
  }, [refresh]);
  useEffect(() => {
    if (!enabled || !data?.enabled || !state) return;
    const sources = pendingWpsAnalysisRecords(state.records).map(record => record.source).filter(source => !attempted.current.has(wpsSourceEvidence(source)));
    sources.forEach(source => attempted.current.add(wpsSourceEvidence(source)));
    void submit(sources);
  }, [enabled, data?.enabled, state, submit]);
  const pending = pendingWpsAnalysisRecords(state?.records ?? []).map(record => record.source);
  const jobs = (data?.jobs ?? []).filter(job => pending.some(source => source.recordId === job.recordId && wpsSourceEvidence(source) === job.evidence));
  const statuses: Record<string, WpsAnalysisStatus> = {};
  for (const job of jobs) if (job.status !== 'completed') statuses[job.recordId] = {
    phase: job.status === 'queued' ? 'queued' : job.status === 'running' ? 'analyzing' : job.status === 'saving' ? 'saving' : 'failed',
    error: job.error ?? undefined, parsed: job.parsed, stage: job.stage ?? undefined, timings: job.timings,
  };
  const failures = jobs.filter(job => ['failed', 'unknown', 'stale'].includes(job.status));
  return {
    available: data?.enabled ?? null, enabled, statuses,
    running: jobs.some(job => ['queued', 'running', 'saving'].includes(job.status)),
    total: jobs.length, completed: jobs.filter(job => job.status === 'completed').length,
    errors: [...(error ? [error] : []), ...(data?.enabled && !data.workerOnline ? ['后台解析服务暂未连接，已提交任务保留在队列中'] : []), ...failures.map(job => job.error || '解析失败')],
    retryFailed: (source?: SourceTaskRecord) => { void submit(source ? [source] : pending.filter(source => failures.some(job => job.recordId === source.recordId) || error), true); },
  };
}
