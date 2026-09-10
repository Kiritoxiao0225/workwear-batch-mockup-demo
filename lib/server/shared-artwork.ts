import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artworkTextLayers, type ArtworkDraft } from '@/lib/artwork-editor';
import { attachProductionArtwork, type ProductionArtwork, type WpsProductionState } from '@/lib/wps-production';
import { latestSharedArtwork, sharedArtworkFixed, sharedArtworkForUnit, type SharedArtwork } from '@/lib/shared-artwork';
import { requestedProductionTextColor } from '@/lib/production-text-color';
import { renderServerArtwork, serverProductionTextColor } from './render-artwork';
import { saveProductionFile, usesProductionCloud } from './production-storage';
import { validateProductionArtworkDraft } from './production-artwork-quality';

export type ArtworkAttachment = Parameters<typeof attachProductionArtwork>[2];
type AppliedArtwork = { unitId: string; artwork?: ArtworkAttachment; error?: string };
export type PreparedSharedArtwork = { group: SharedArtwork; source: ArtworkAttachment; automaticTextColor: boolean; applications: AppliedArtwork[]; attemptId: string; reuseVersion?: number };
const colors = (draft?: ArtworkDraft) => draft ? artworkTextLayers(draft).map(text => [text.id, text.color]) : [];
async function saveRendered(bytes: Buffer) {
  const name = `shared-${randomUUID()}.png`;
  if (usesProductionCloud()) return saveProductionFile(bytes, name);
  await mkdir(path.join(process.cwd(), 'public/uploads/logos'), { recursive: true });
  await writeFile(path.join(process.cwd(), 'public/uploads/logos', name), bytes);
  return { url: `/uploads/logos/${name}` };
}

/** Only rendering varies by application. Never invokes generation, enhancement or cutout. */
export async function prepareSharedArtwork(state: WpsProductionState, unitId: string, source: ArtworkAttachment,
  options: { preserveExisting?: boolean; applyUnitId?: string; applyUnitIds?: string[]; attemptId?: string } = {}): Promise<PreparedSharedArtwork | null> {
  const group = sharedArtworkForUnit(state, unitId);
  if (!group) return null;
  if (group.sourceUnitId !== unitId) throw new Error('请从共用图稿入口编辑，或先拆出此位置');
  if (!source.validation.valid) throw new Error('源稿透明素材检查未通过，请先修正源稿');
  const applyIds = options.applyUnitIds ?? (options.applyUnitId ? [options.applyUnitId] : undefined);
  const unit = state.units.find(unit => unit.id === unitId)!;
  const previous = latestSharedArtwork(group);
  const automaticTextColor = source.service === 'manual-upload' && previous
    ? previous.automaticTextColor && JSON.stringify(colors(source.draft)) === JSON.stringify(colors(previous.artwork.draft))
    : !requestedProductionTextColor(unit) && (source.service !== 'manual-upload' || unit.attempts.at(-1)?.service !== 'manual-upload' && unit.attempts.length > 0);
  const rendered = new Map<string, Promise<ArtworkAttachment>>();
  const applications: AppliedArtwork[] = [];
  for (const id of group.unitIds) {
    const target = state.units.find(unit => unit.id === id)!;
    if (applyIds && !applyIds.includes(id)) continue;
    if (sharedArtworkFixed(state, id)) continue;
    if (options.preserveExisting && target.artwork && id !== unitId && target.artwork.validation.sha256 !== source.validation.sha256) continue;
    if (!applyIds && !options.preserveExisting && target.artwork && target.sharedArtworkVersion === 0 && id !== unitId) continue;
    try {
      let draft = source.draft ? structuredClone(source.draft) : undefined;
      if (draft?.text && automaticTextColor && id !== unitId) {
        const color = requestedProductionTextColor(target) ?? await serverProductionTextColor(target);
        draft = { ...draft, text: { ...draft.text, color }, extraTexts: draft.extraTexts?.map(text => ({ ...text, color })) };
      }
      const same = JSON.stringify(draft) === JSON.stringify(source.draft);
      if (same) applications.push({ unitId: id, artwork: { ...source, automaticWidthCm: id === unitId ? source.automaticWidthCm : undefined } });
      else {
        const key = JSON.stringify(draft);
        if (!rendered.has(key)) rendered.set(key, (async () => {
          const output = await renderServerArtwork(draft!);
          const saved = await saveRendered(output.bytes);
          const verified = await validateProductionArtworkDraft(saved.url, draft, source.validation, source.draft);
          if (!verified.validation.valid) throw new Error('此配色的透明素材检查未通过，请核对');
          return { ...source, url: saved.url, draft: verified.draft, validation: verified.validation, automaticWidthCm: undefined };
        })());
        applications.push({ unitId: id, artwork: await rendered.get(key)! });
      }
    } catch (error) { applications.push({ unitId: id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { group, source, applications, automaticTextColor, attemptId: options.attemptId ?? randomUUID(),
    ...(applyIds ? { reuseVersion: previous?.number } : {}) };
}

export function commitSharedArtwork(state: WpsProductionState, prepared: PreparedSharedArtwork): WpsProductionState {
  const group = sharedArtworkForUnit(state, prepared.group.sourceUnitId);
  if (!group || group.id !== prepared.group.id) throw new Error('共用关系已变化');
  const number = prepared.reuseVersion ?? (latestSharedArtwork(group)?.number ?? 0) + 1;
  const now = new Date();
  const sourceArtwork: ProductionArtwork = { url: prepared.source.url, name: prepared.source.name,
    draft: prepared.source.draft, validation: prepared.source.validation,
    recipeFingerprint: state.units.find(unit => unit.id === group.sourceUnitId)!.recipeFingerprint, createdAt: now.toISOString() };
  let next = state;
  // The source garment can be pinned while a new source version is prepared.
  // Keep its artwork and confirmation intact, and still record this run once.
  if (!prepared.reuseVersion && !prepared.applications.some(item => item.unitId === group.sourceUnitId && item.artwork)) {
    const accounted = attachProductionArtwork(state, group.sourceUnitId, prepared.source, prepared.attemptId, now);
    next = { ...next, units: next.units.map(unit => unit.id === group.sourceUnitId
      ? { ...unit, attempts: accounted.units.find(item => item.id === unit.id)!.attempts } : unit) };
  }
  for (const applied of prepared.applications) {
    const original = state.units.find(unit => unit.id === applied.unitId)!;
    if (sharedArtworkFixed(state, original.id)) continue;
    let appliedSuccessfully = false;
    if (applied.artwork) try {
      next = attachProductionArtwork(next, original.id, { ...applied.artwork,
        service: original.id === group.sourceUnitId && !prepared.reuseVersion ? prepared.source.service : 'manual-upload',
        actualCostCny: original.id === group.sourceUnitId && !prepared.reuseVersion ? prepared.source.actualCostCny : 0,
        estimatedCostCny: original.id === group.sourceUnitId && !prepared.reuseVersion ? prepared.source.estimatedCostCny : 0,
        requestSummary: `共用图稿 v${number}；${prepared.source.requestSummary}`,
      }, prepared.attemptId, now);
      appliedSuccessfully = true;
    } catch (error) {
      if (original.id === group.sourceUnitId) throw error;
      applied.error = error instanceof Error ? error.message : String(error);
    }
    next = { ...next, units: next.units.map(unit => unit.id !== original.id ? unit : { ...unit,
      sharedArtworkVersion: appliedSuccessfully ? number : unit.sharedArtworkVersion,
      sharedArtworkError: applied.error,
      // One actual run is accounted for once, at its source.
      attempts: original.id === group.sourceUnitId && !prepared.reuseVersion ? unit.attempts : original.attempts,
    }) };
  }
  const versions = prepared.reuseVersion ? group.versions : [...group.versions, { number, artwork: sourceArtwork,
    automaticTextColor: prepared.automaticTextColor, createdAt: now.toISOString() }];
  return { ...next, revision: state.revision + 1, updatedAt: now.toISOString(),
    sharedArtworks: [...(next.sharedArtworks ?? []).filter(item => item.id !== group.id), { ...group, versions }],
    mockupVersions: next.mockupVersions.map(version => state.mockupVersions.find(old => old.id === version.id && old.finalConfirmation) ?? version),
  };
}

export function existingSharedAttachment(artwork: ProductionArtwork): ArtworkAttachment {
  return { ...artwork, service: 'manual-upload', requestSummary: '应用已有共用图稿，无需重新制作', actualCostCny: 0 };
}
