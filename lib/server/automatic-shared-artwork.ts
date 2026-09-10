import type { SourceTaskRecord } from '@/lib/batch-task-review';
import { autoLinkSharedArtworks } from '@/lib/shared-artwork';
import { canAnalyzeWpsTask, wpsSourceEvidence } from '@/lib/wps-source';
import { catalogDatabase } from './catalog-database';
import { productionStateKey } from './production-storage';
import { mutateWpsProductionState, ProductionRevisionConflictError, readWpsProductionState } from './wps-production-store';

/** Called under the discovery lease. No browser writes, rendering or model calls. */
export async function reconcileAutomaticSharedArtworks(sources: SourceTaskRecord[]) {
  const state = await readWpsProductionState();
  const recordIds = new Set(sources.filter(source => canAnalyzeWpsTask(source) && state.records.some(record =>
    record.source.recordId === source.recordId && wpsSourceEvidence(record.source) === wpsSourceEvidence(source)))
    .map(source => source.recordId));
  if (autoLinkSharedArtworks(state, { recordIds }) === state) return state;
  const [jobs, analyses] = await Promise.all([
    catalogDatabase().query("SELECT unit_id FROM artwork_jobs WHERE state_key=$1", [productionStateKey()]),
    catalogDatabase().query("SELECT record_id FROM wps_analysis_jobs WHERE state_key=$1 AND status IN ('queued','running','saving','unknown') OR (state_key=$1 AND status='failed' AND result_json IS NOT NULL)", [productionStateKey()]),
  ]);
  for (const row of analyses.rows) recordIds.delete(row.record_id);
  const options = { recordIds, blockedUnitIds: new Set<string>(jobs.rows.map(row => row.unit_id)) };
  const next = autoLinkSharedArtworks(state, options);
  if (next === state) return state;
  try {
    // A concurrent edit fails CAS; the next discovery recomputes against fresh data.
    // The existing commit row lock also rejects a job queued after this preflight.
    return await mutateWpsProductionState(state.revision, current => autoLinkSharedArtworks(current, options));
  } catch (error) {
    if (error instanceof ProductionRevisionConflictError || error instanceof Error && error.message === '图案正在制作，暂不能更改共用关系') return state;
    throw error;
  }
}
