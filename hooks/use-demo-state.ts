'use client';
import { fetchApi, readApiJson } from '@/lib/client/api-response';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  readBrowserDemoState,
  usesBrowserStorage,
  writeBrowserDemoState,
} from '@/lib/client/browser-demo-store';
import type { DemoState } from '@/lib/types';

type SaveStatus = 'loading' | 'saved' | 'saving' | 'error';
// A newly mounted picker/workbench must wait for the previous page's final edit.
let pendingDemoSave: Promise<void> = Promise.resolve();

async function stateResponse(response: Response) {
  return readApiJson(response, '读写批次状态失败') as Promise<DemoState>;
}

async function fetchDemoState() {
  await pendingDemoSave;
  if (usesBrowserStorage()) return readBrowserDemoState();
  const response = await fetchApi('/api/state', { cache: 'no-store' });
  return stateResponse(response);
}

async function saveDemoState(state: DemoState) {
  if (usesBrowserStorage()) return writeBrowserDemoState(state);
  const response = await fetchApi('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  return stateResponse(response);
}

export function useDemoState() {
  const [state, setState] = useState<DemoState | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<DemoState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSequenceRef = useRef(0);
  const flushSaveRef = useRef<(() => void) | null>(null);

  const reload = useCallback(async () => {
    setSaveStatus('loading');
    setError(null);
    try {
      const nextState = await fetchDemoState();
      stateRef.current = nextState;
      setState(nextState);
      setSaveStatus('saved');
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
      setSaveStatus('error');
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void fetchDemoState()
      .then((nextState) => {
        if (disposed) return;
        stateRef.current = nextState;
        setState(nextState);
        setSaveStatus('saved');
      })
      .catch((loadError: unknown) => {
        if (disposed) return;
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        setError(message);
        setSaveStatus('error');
      });
    return () => {
      disposed = true;
      flushSaveRef.current?.();
    };
  }, []);

  const enqueueSave = useCallback((nextState: DemoState) => {
    const sequence = ++saveSequenceRef.current;
    setSaveStatus('saving');
    setError(null);
    const save = async () => {
      await saveDemoState(nextState);
      if (sequence === saveSequenceRef.current) setSaveStatus('saved');
    };
    const queued = pendingDemoSave.then(save, save);
    pendingDemoSave = queued;
    void queued.catch((saveError: unknown) => {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      setSaveStatus('error');
    });
    return queued;
  }, []);

  useEffect(() => {
    const flush = () => {
      if (!saveTimerRef.current || !stateRef.current) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void enqueueSave(stateRef.current).catch(() => {});
    };
    flushSaveRef.current = flush;
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); };
  }, [enqueueSave]);

  const updateState = useCallback((
    updater: (current: DemoState) => DemoState,
    options?: { immediate?: boolean },
  ) => {
    const current = stateRef.current;
    if (!current) throw new Error('Demo 状态尚未加载完成');
    const nextState = updater(current);
    stateRef.current = nextState;
    setState(nextState);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (options?.immediate) return enqueueSave(nextState);
    setSaveStatus('saving');
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void enqueueSave(nextState);
    }, 280);
    return Promise.resolve();
  }, [enqueueSave]);

  return { state, saveStatus, error, reload, updateState };
}
