'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConditionalJsonReader } from '@/lib/client/conditional-json';
import { artworkPollDelay } from '@/lib/artwork-polling';
import type { ArtworkJobsResponse } from '@/lib/artwork-jobs';

export function useArtworkJobs(enabled: boolean) {
  const [data, setData] = useState<ArtworkJobsResponse | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const reader = useRef(new ConditionalJsonReader('/api/wps-production/jobs'));
  const lastData = useRef<ArtworkJobsResponse | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback((signal?: AbortSignal) => {
    if (inFlight.current) return inFlight.current;
    const id = ++requestId.current;
    const work = (async () => {
      try {
        const response = await reader.current.read(signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000));
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '读取后台制作队列失败');
        if (id === requestId.current && mounted.current) { lastData.current = payload; setData(payload); setError(''); }
      } catch (error) { if (!signal?.aborted && id === requestId.current && mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    })().finally(() => { if (inFlight.current === work) inFlight.current = null; });
    inFlight.current = work;
    return work;
  }, []);
  const active = data?.jobs.some(job => ['queued', 'running'].includes(job.status));
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return () => { mounted.current = false; };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>, epoch = 0;
    const poll = async () => { const own = ++epoch; clearTimeout(timer); await refresh(abort.signal); if (!abort.signal.aborted && own === epoch) timer = setTimeout(poll, artworkPollDelay(lastData.current?.jobs ?? [], document.hidden)); };
    const focus = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    void poll(); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { mounted.current = false; ++epoch; abort.abort(); inFlight.current = null; clearTimeout(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [enabled, refresh, active]);
  const submit = async (body: unknown) => {
    setSubmitting(true);
    // Invalidate a GET started before this mutation; it cannot erase the newly queued jobs.
    ++requestId.current;
    reader.current.invalidate(); inFlight.current = null;
    try {
      const response = await fetch('/api/wps-production/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '提交后台制作任务失败');
      ++requestId.current;
      reader.current.invalidate();
      if (mounted.current) { lastData.current = payload; setData(payload); setError(''); }
      return payload as ArtworkJobsResponse & { results?: { unitId: string; error?: string }[] };
    } finally { if (mounted.current) setSubmitting(false); }
  };
  return { data, error, submitting, refresh, submit };
}
