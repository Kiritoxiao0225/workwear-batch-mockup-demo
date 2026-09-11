import { parseArtworkFontReference, fontReferenceInput } from '@/lib/artwork-font-reference';
import { artworkInputSelection } from '@/lib/artwork-reference';
import { NextResponse } from 'next/server';
import { productionUser } from '@/lib/server/production-storage';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { listWpsSourceTaskRecords } from '@/lib/server/wps-dbsheet';
import { planArtworkGenerationPrompt } from '@/lib/server/ark-task-review';
import { assertProductionArtworkSnapshot, ProductionArtworkConflictError } from '@/lib/production-artwork-snapshot';
import { canAnalyzeWpsTask, wpsSourceEvidence } from '@/lib/wps-source';
import { buildCanonicalArtworkModelPrompt } from '@/lib/task-review-artwork';
import { CatalogHttpError } from '@/lib/server/catalog-auth';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const body = await request.json();
    if (!body || typeof body.unitId !== 'string' || typeof body.expectedUnitSnapshot !== 'string') return NextResponse.json({ error: '缺少图案身份或当前快照，请重新打开' }, { status: 400 });
    const state = await readWpsProductionState();
    assertProductionArtworkSnapshot(state, body.unitId, body.expectedUnitSnapshot);
    const savedUnit = state.units.find(unit => unit.id === body.unitId)!;
    const draft = body.draft;
    const unit = { ...savedUnit };
    if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
      for (const field of ['instruction', 'layoutNote', 'exactText'] as const) {
        if (field in draft) { if (typeof draft[field] !== 'string' || draft[field].length > 4000) throw new Error('制作草稿格式无效'); unit[field] = draft[field]; }
      }
      if ('fontReference' in draft) unit.fontReference = parseArtworkFontReference(draft.fontReference);
      if (draft.textMode === 'replace' || draft.textMode === 'keep' || draft.textMode === 'none') unit.textMode = draft.textMode;
    }
    const stored = state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source;
    const source = (await listWpsSourceTaskRecords({ recordIds: [unit.sourceRecordId] })).records.find(record => record.recordId === unit.sourceRecordId);
    if (!source || !canAnalyzeWpsTask(source) || wpsSourceEvidence(source) !== wpsSourceEvidence(stored)) return NextResponse.json({ error: '原表需求、素材或状态已变化，请同步后重新整理提示词' }, { status: 409 });
    const result = await planArtworkGenerationPrompt(source, { fontReference: unit.fontReference, id: unit.id, garmentLabel: unit.garmentLabel, variantLabel: unit.variantLabel, placement: unit.placement, instruction: unit.instruction, layoutNote: unit.layoutNote, exactText: unit.exactText, textMode: unit.textMode, sourceScope: unit.sourceScope, artworkMethod: unit.artworkMethod });
    const materialId = result.primaryImageLabel ? source.materials[Number(result.primaryImageLabel.slice(1)) - 1].id : null;
    const referenceMaterialIds = result.referenceImageLabels.map(label => source.materials[Number(label.slice(1)) - 1].id);
    const selection = artworkInputSelection(source, { ...unit, materialId, referenceMaterialIds, fontReference: result.fontReference });
    const compiled = buildCanonicalArtworkModelPrompt({ fontReference: fontReferenceInput(source, result), generationPrompt: result.generationPrompt, instruction: unit.instruction, layoutNote: '',
      sourceRequirementText: source.requirementText, exactText: unit.exactText, sourceScope: unit.sourceScope,
      primaryImageLabel: selection.primaryImageLabel,
      primaryImageRole: selection.primaryImageRole,
      referenceImageLabels: selection.referenceMaterialIds.map(id => `图${source.materials.findIndex(material => material.id === id) + 1}`) });
    assertProductionArtworkSnapshot(await readWpsProductionState(), body.unitId, body.expectedUnitSnapshot);
    return NextResponse.json({ ...result, finalPrompt: compiled.prompt, materialId, referenceMaterialIds });
  } catch (error) {
    if (error instanceof CatalogHttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof ProductionArtworkConflictError ? 409 : 502 });
  }
}
