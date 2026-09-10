'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtworkJobsResponse } from '@/lib/artwork-jobs';

export function useArtworkJobs(enabled: boolean) {
  const [data, setData] = useState<ArtworkJobsResponse | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    try {
      const response = await fetch('/api/wps-production/jobs', { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取后台制作队列失败');
      if (id === requestId.current && mounted.current) { setData(payload); setError(''); }
    } catch (error) { if (!signal?.aborted && id === requestId.current && mounted.current) setError(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return () => { mounted.current = false; };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(abort.signal); if (!abort.signal.aborted) timer = setTimeout(poll, document.hidden ? 15_000 : 2500); };
    const focus = () => { void refresh(abort.signal); };
    void poll(); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { mounted.current = false; abort.abort(); clearTimeout(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [enabled, refresh]);
  const submit = async (body: unknown) => {
    setSubmitting(true);
    // Invalidate a GET started before this mutation; it cannot erase the newly queued jobs.
    ++requestId.current;
    try {
      const response = await fetch('/api/wps-production/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '提交后台制作任务失败');
      ++requestId.current;
      if (mounted.current) { setData(payload); setError(''); }
      return payload as ArtworkJobsResponse & { results?: { unitId: string; error?: string }[] };
    } finally { if (mounted.current) setSubmitting(false); }
  };
  return { data, error, submitting, refresh, submit };
}
