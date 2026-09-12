import { canonicalJson } from './artwork-reliability';
export type ProductionRenderOutcome = { inputKey: string; status: 'pending' | 'ready' | 'failed'; updatedAt: string;
  retryAfter: string; attempts: number; error: string | null; url?: string; sha256?: string };
/** Only actual composition inputs; editing a job message must not trigger a new render. */
export function productionRenderInputKey(version: { id: string; garment?: unknown }, units: Array<{ id: string; garment?: unknown; placement?: unknown;
  gateA?: unknown; artwork?: { validation: { sha256: string } } | null }>, compositor: string): string {
  return canonicalJson({ versionId: version.id, compositor, garment: version.garment,
    units: [...units].sort((a, b) => a.id.localeCompare(b.id)).map(unit => ({ id: unit.id, garment: unit.garment, placement: unit.placement,
      confirmedPlacement: !!unit.gateA, artwork: unit.artwork?.validation.sha256 ?? null })) });
}
export function renderNeedsRecovery(outcome: ProductionRenderOutcome | undefined, inputKey: string, now = Date.now()): boolean {
  if (!outcome || outcome.inputKey !== inputKey) return true;
  if (outcome.status === 'ready') return false;
  return !Number.isFinite(Date.parse(outcome.retryAfter)) || Date.parse(outcome.retryAfter) <= now;
}
