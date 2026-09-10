import type { ArtworkCutoutResult } from '@/lib/artwork-cutout';
import type { ProductionUnit, WpsProductionState } from '@/lib/wps-production';
import { assertProductionArtworkSnapshot, assertProductionSharedSnapshot, productionSharedSnapshot } from '@/lib/production-artwork-snapshot';

export type CutoutSession = { result: ArtworkCutoutResult; snapshot: string; sharedSnapshot?: string; purpose?: 'recut' | 'generated' | 'component'; stale?: boolean };
type Bookmark = Pick<CutoutSession, 'snapshot' | 'sharedSnapshot' | 'purpose'> & { jobKey: string; batchId: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export const CUTOUT_BOOKMARK_KEY = 'wps-artwork-cutouts-v1';

/** Include intermediate steps: the final cutout alone does not describe a redraw run. */
export function artworkUsedCutout(unit: ProductionUnit | undefined, jobKey: string) {
  const preprocessing = unit?.artwork?.draft?.preprocessing;
  return Boolean(preprocessing?.cutout?.jobKey === jobKey || preprocessing?.cutoutRuns?.some(run => run.jobKey === jobKey));
}

export function cutoutSessionForState(state: WpsProductionState | null, unitId: string, session: CutoutSession) {
  if (!state || artworkUsedCutout(state.units.find(unit => unit.id === unitId), session.result.receipt.jobKey)) return null;
  let stale = false;
  try { assertProductionArtworkSnapshot(state, unitId, session.snapshot); } catch { stale = true; }
  try { if (session.sharedSnapshot) assertProductionSharedSnapshot(state, unitId, session.sharedSnapshot); } catch { stale = true; }
  return session.stale === stale ? session : { ...session, stale };
}

/** Browser bookmarks are recovery pointers, never the authority for a saved artwork. */
export class ArtworkCutoutSessions {
  private state: WpsProductionState | null = null;
  private sessions: Record<string, CutoutSession> = {};
  private listeners = new Set<() => void>();
  private epochs = new Map<string, number>();
  constructor(private storage: () => Storage) {}
  getSnapshot = () => this.sessions;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(sessions: Record<string, CutoutSession>) {
    this.sessions = sessions;
    this.listeners.forEach(listener => listener());
  }
  private bookmarks(): Record<string, Bookmark> {
    try {
      const raw = JSON.parse(this.storage().getItem(CUTOUT_BOOKMARK_KEY) || '{}');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, Bookmark] => {
        const value = entry[1] as Partial<Bookmark> | null;
        return Boolean(value && typeof value.jobKey === 'string' && /^[a-f0-9]{64}$/u.test(value.jobKey)
          && typeof value.snapshot === 'string' && typeof value.batchId === 'string'
          && (value.purpose === undefined || ['component', 'generated', 'recut'].includes(value.purpose)));
      }));
    } catch { return {}; }
  }
  private save(bookmarks: Record<string, Bookmark>) {
    try { this.storage().setItem(CUTOUT_BOOKMARK_KEY, JSON.stringify(bookmarks)); } catch { /* Server task receipts remain available. */ }
  }
  discard = (unitId: string) => {
    this.epochs.set(unitId, (this.epochs.get(unitId) ?? 0) + 1);
    const bookmarks = this.bookmarks();
    if (bookmarks[unitId]?.batchId === this.state?.batchId) { delete bookmarks[unitId]; this.save(bookmarks); }
    if (this.sessions[unitId]) {
      const next = { ...this.sessions }; delete next[unitId]; this.publish(next);
    }
  };
  reconcile(state: WpsProductionState) {
    if (this.state?.batchId === state.batchId && this.state.revision > state.revision) return;
    if (this.state && this.state.batchId !== state.batchId) {
      for (const id of this.epochs.keys()) this.epochs.set(id, this.epochs.get(id)! + 1);
      this.publish({});
    }
    this.state = state;
    for (const [unitId, bookmark] of Object.entries(this.bookmarks())) {
      if (bookmark.batchId === state.batchId && artworkUsedCutout(state.units.find(unit => unit.id === unitId), bookmark.jobKey)) this.discard(unitId);
    }
    const next: Record<string, CutoutSession> = {};
    for (const [unitId, session] of Object.entries(this.sessions)) {
      const visible = cutoutSessionForState(state, unitId, session);
      if (visible) next[unitId] = visible;
      else this.discard(unitId);
    }
    if (Object.keys(next).length !== Object.keys(this.sessions).length || Object.entries(next).some(([id, session]) => this.sessions[id] !== session)) this.publish(next);
  }
  remember(unitId: string, result: ArtworkCutoutResult, snapshot: string, purpose: CutoutSession['purpose'] = 'recut', sharedSnapshot?: string) {
    if (!this.state) return false;
    sharedSnapshot ??= this.sessions[unitId]?.sharedSnapshot ?? (this.state.units.find(unit => unit.id === unitId)?.sharedArtworkId ? productionSharedSnapshot(this.state, unitId) : undefined);
    const session = cutoutSessionForState(this.state, unitId, { result, snapshot, purpose, sharedSnapshot });
    if (!session) { this.discard(unitId); return false; }
    this.epochs.set(unitId, (this.epochs.get(unitId) ?? 0) + 1);
    this.save({ ...this.bookmarks(), [unitId]: { jobKey: result.receipt.jobKey, snapshot, sharedSnapshot, purpose, batchId: this.state.batchId } });
    this.publish({ ...this.sessions, [unitId]: session });
    return true;
  }
  async restore(query: (jobKey: string) => Promise<ArtworkCutoutResult>, cancelled = () => false) {
    const batchId = this.state?.batchId;
    await Promise.all(Object.entries(this.bookmarks()).map(async ([unitId, bookmark]) => {
      if (bookmark.batchId !== batchId || this.sessions[unitId] || !this.state?.units.some(unit => unit.id === unitId)) return;
      if (artworkUsedCutout(this.state?.units.find(unit => unit.id === unitId), bookmark.jobKey)) { this.discard(unitId); return; }
      const epoch = this.epochs.get(unitId) ?? 0;
      this.epochs.set(unitId, epoch);
      try {
        const result = await query(bookmark.jobKey);
        // A late query must not resurrect a dismissed/consumed task or replace a newer one.
        const current = this.bookmarks()[unitId];
        if (cancelled() || this.state?.batchId !== batchId || this.epochs.get(unitId) !== epoch
          || current?.jobKey !== bookmark.jobKey || current?.snapshot !== bookmark.snapshot) return;
        this.remember(unitId, result, bookmark.snapshot, bookmark.purpose, bookmark.sharedSnapshot);
      } catch { /* Keep the original bookmark for a later signed-in visit. */ }
    }));
  }
}
