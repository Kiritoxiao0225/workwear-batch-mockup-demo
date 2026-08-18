'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  readBrowserDemoState,
  usesBrowserStorage,
  writeBrowserDemoState,
} from '@/lib/client/browser-demo-store';
import type { DemoState } from '@/lib/types';

type SaveStatus = 'loading' | 'saved' | 'saving' | 'error';

async function stateResponse(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      ? String(body.error)
      : `请求失败：HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as DemoState;
}

async function fetchDemoState() {
  if (usesBrowserStorage()) return readBrowserDemoState();
  const response = await fetch('/api/state', { cache: 'no-store' });
  return stateResponse(response);
}

async function saveDemoState(state: DemoState) {
  if (usesBrowserStorage()) return writeBrowserDemoState(state);
  const response = await fetch('/api/state', {
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
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

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
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
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
    const queued = saveQueueRef.current.then(save, save);
    saveQueueRef.current = queued.catch((saveError: unknown) => {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      setSaveStatus('error');
    });
    return queued;
  }, []);

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
