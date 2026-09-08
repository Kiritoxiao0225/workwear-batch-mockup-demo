import { readCloudProductionState } from './production-cloud-state';
import { savedProductionRender } from './production-render-cache';
import { cleanupReplacedFiles } from './production-replaced-files';

const changesPicture = new Set(['submitArtwork', 'saveArtworkDraft', 'updatePlan', 'confirmPlan',
  'placeArtwork', 'savePlacements', 'selectGarment', 'pollGptImage2', 'confirmArtwork', 'returnUnit']);

/** State and preview reads can arrive together; they share one cleanup check.
 * Writes still get a fresh pass so files queued during a previous pass are seen.
 */
export function createProductionCleanupScheduler(run = cleanupReplacedFiles, now = Date.now) {
  let active: ReturnType<typeof cleanupReplacedFiles> | null = null;
  let lastReadCheck = -Infinity;
  const schedule = async (write: boolean): ReturnType<typeof cleanupReplacedFiles> => {
    if (active) {
      if (!write) return active;
      try { await active; } catch { /* A new write can retry the recorded queue. */ }
      return schedule(true);
    }
    if (!write && now() - lastReadCheck < 30_000) return { deleted: [], failures: [] };
    if (!write) lastReadCheck = now();
    active = run();
    try { return await active; }
    catch (error) { if (!write) lastReadCheck = -Infinity; throw error; }
    finally { active = null; }
  };
  return schedule;
}
const cleanupAfterResponse = createProductionCleanupScheduler();

/** Awaited by Next after(): works for a request on Vercel without a resident worker. */
export async function finishProductionSave(body: Record<string, unknown> = {}) {
  try {
    // Whole-garment confirmation is immediately followed by composeVersion.
    // Let that foreground request own rendering, instead of starting a rival.
    const composingNext = body.action === 'savePlacements' && body.confirmWholeVersion === true;
    if (changesPicture.has(String(body.action)) && !composingNext) {
      const state = await readCloudProductionState();
      const unitIds = new Set([body.unitId, ...(Array.isArray(body.updates)
        ? body.updates.map(update => update?.unitId) : [])]);
      const versions = state.mockupVersions.filter(version => version.id === body.versionId || version.unitIds.some(id => unitIds.has(id)));
      for (const version of versions) {
        const units = version.unitIds.map(id => state.units.find(unit => unit.id === id)!);
        if (!version.garment || !units.some(unit => unit?.artwork && unit.placement && unit.garment)) continue;
        try { await savedProductionRender(version, units); }
        catch (error) { console.error('效果图更新失败；保留当前成品，打开预览时可重试', error); }
      }
    }
  } catch (error) { console.error('保存后的效果图更新失败', error); }
  try {
    const result = await cleanupAfterResponse(Boolean(body.action));
    if (result.failures.length) console.error('旧图删除待下次请求重试', result.failures);
  } catch (error) { console.error('旧图删除待下次请求重试', error); }
}
