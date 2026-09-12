import { productionPreviewFixed } from '@/lib/production-preview';
import { savedProductionRender } from './production-render-cache';
import { readWpsProductionState, mutateWpsProductionState } from './wps-production-store';
import { WPS_COMPOSITOR_VERSION, type ProductionMockupVersion, type ProductionUnit, type WpsProductionState } from '@/lib/wps-production';
import { productionRenderInputKey, renderNeedsRecovery, type ProductionRenderOutcome } from '@/lib/production-render-outcome';
import { isActiveSourceStatus, safeErrorText } from '@/lib/artwork-reliability';
import { preflightResolvedArtworkUnit } from './artwork-preflight';

function currentInput(state: WpsProductionState, versionId: string) {
  const version = state.mockupVersions.find(item => item.id === versionId);
  if (!version) throw new Error('效果图版本已不存在');
  const units = version.unitIds.map(id => state.units.find(unit => unit.id === id)).filter((unit): unit is ProductionUnit => !!unit);
  if (units.length !== version.unitIds.length) throw new Error('效果图的印花位置已变化');
  return { version, units, key: productionRenderInputKey(version, units, WPS_COMPOSITOR_VERSION) };
}
async function outcome(versionId: string, expectedKey: string, value: ProductionRenderOutcome) {
  const current = await readWpsProductionState();
  return mutateWpsProductionState(current.revision, state => ({ ...state,
    renderOutcomes: { ...(state.renderOutcomes ?? {}), [versionId]: state.renderOutcomes?.[versionId]?.inputKey === expectedKey && state.renderOutcomes[versionId].status === 'ready' && value.status !== 'ready'
      ? state.renderOutcomes[versionId] : value }, revision: state.revision + 1, updatedAt: new Date().toISOString(),
  }), state => { if (currentInput(state, versionId).key !== expectedKey) throw new Error('合成输入已变化，旧预览没有覆盖新版本'); });
}
/** Durable recovery state; no generation, cutout, scoring or WPS writes. */
export async function trackedProductionRender(version: ProductionMockupVersion, units: ProductionUnit[]) {
  const inputKey = productionRenderInputKey(version, units, WPS_COMPOSITOR_VERSION);
  const state = await readWpsProductionState();
  const previous = state.renderOutcomes?.[version.id];
  const attempts = previous?.inputKey === inputKey ? previous.attempts + 1 : 1;
  const make = (status: ProductionRenderOutcome['status'], error: string | null, extra: Partial<ProductionRenderOutcome> = {}): ProductionRenderOutcome => ({
    inputKey, status, error, attempts, updatedAt: new Date().toISOString(),
    retryAfter: new Date(Date.now() + (status === 'pending' ? 330_000 : Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts - 1, 7)))).toISOString(), ...extra });
  await outcome(version.id, inputKey, make('pending', null));
  try {
    const saved = await savedProductionRender(version, units);
    await outcome(version.id, inputKey, make('ready', null, { url: `/api/production-files/${saved.file.id}`, sha256: saved.file.sha256 }));
    return saved;
  } catch (error) {
    await outcome(version.id, inputKey, make('failed', safeErrorText(error))).catch(() => undefined);
    throw error;
  }
}
/** Recover a small number per pass. Historical completed orders are never bulk rerendered. */
export async function recoverProductionRenders(limit = 2) {
  const state = await readWpsProductionState();
  const eligible: ProductionMockupVersion[] = [];
  for (const version of state.mockupVersions) {
    const source = state.records.find(record => record.source.recordId === version.sourceRecordId)?.source;
    if (version.finalConfirmation || !source?.wpsSource || !isActiveSourceStatus(source.wpsSource.status)) continue;
    const { units, key } = currentInput(state, version.id);
    if (!units.length || units.some(unit => !unit.artwork) || !renderNeedsRecovery(state.renderOutcomes?.[version.id], key)) continue;
    if (!state.renderOutcomes?.[version.id] && version.output?.composeFingerprint === version.composeFingerprint && version.output) continue;
    const checks = await Promise.all(units.map(unit => preflightResolvedArtworkUnit(unit, source, 'preview', { fixed: productionPreviewFixed(unit, [version]) })));
    if (checks.some(check => check.garmentIssue || check.artworkIssue)) continue;
    eligible.push(version);
    if (eligible.length >= Math.max(1, Math.min(10, limit))) break;
  }
  const results = [];
  for (const version of eligible) {
    try { const { units } = currentInput(state, version.id); await trackedProductionRender(version, units); results.push({ versionId: version.id, status: 'ready' }); }
    catch (error) { results.push({ versionId: version.id, status: 'failed', error: safeErrorText(error) }); }
  }
  return results;
}
