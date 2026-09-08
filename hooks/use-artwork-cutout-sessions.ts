'use client';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { WpsProductionState } from '@/lib/wps-production';
import { ArtworkCutoutSessions, cutoutSessionForState, type CutoutSession } from '@/lib/client/artwork-cutout-sessions';
import { cutoutRequest } from '@/components/wps-cutout-controls';

export function useArtworkCutoutSessions(production: WpsProductionState | null, enabled: boolean) {
  const [store] = useState(() => new ArtworkCutoutSessions(() => window.localStorage));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { if (production) store.reconcile(production); }, [store, production]);
  const batchId = production?.batchId;
  useEffect(() => {
    if (!batchId || !enabled) return;
    let cancelled = false;
    void store.restore(jobKey => cutoutRequest({ action: 'query', jobKey }), () => cancelled);
    return () => { cancelled = true; };
  }, [store, batchId, enabled]);
  // Hide consumed results in the same render as the saved artwork, before effect cleanup.
  const sessions = useMemo(() => Object.fromEntries(Object.entries(snapshot).flatMap(([id, session]) => {
    const visible = cutoutSessionForState(production, id, session);
    return visible ? [[id, visible] as [string, CutoutSession]] : [];
  })), [snapshot, production]);
  return { sessions, store };
}
