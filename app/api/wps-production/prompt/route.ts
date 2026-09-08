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
    const unit = state.units.find(unit => unit.id === body.unitId)!;
    const stored = state.records.find(record => record.source.recordId === unit.sourceRecordId)!.source;
    const source = (await listWpsSourceTaskRecords()).records.find(record => record.recordId === unit.sourceRecordId);
    if (!source || !canAnalyzeWpsTask(source) || wpsSourceEvidence(source) !== wpsSourceEvidence(stored)) return NextResponse.json({ error: '原表需求、素材或状态已变化，请同步后重新整理提示词' }, { status: 409 });
    const result = await planArtworkGenerationPrompt(source, { id: unit.id, garmentLabel: unit.garmentLabel, variantLabel: unit.variantLabel, placement: unit.placement, instruction: unit.instruction, layoutNote: unit.layoutNote, exactText: unit.exactText, textMode: unit.textMode, sourceScope: unit.sourceScope, artworkMethod: unit.artworkMethod });
    const compiled = buildCanonicalArtworkModelPrompt({ generationPrompt: result.generationPrompt, instruction: unit.instruction, layoutNote: '',
      sourceRequirementText: source.requirementText, exactText: unit.exactText, sourceScope: unit.sourceScope,
      primaryImageLabel: result.primaryImageLabel, referenceImageLabels: result.referenceImageLabels });
    assertProductionArtworkSnapshot(await readWpsProductionState(), body.unitId, body.expectedUnitSnapshot);
    return NextResponse.json({ ...result, finalPrompt: compiled.prompt,
      materialId: source.materials[Number(result.primaryImageLabel.slice(1)) - 1].id,
      referenceMaterialIds: result.referenceImageLabels.map(label => source.materials[Number(label.slice(1)) - 1].id) });
  } catch (error) {
    if (error instanceof CatalogHttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof ProductionArtworkConflictError ? 409 : 502 });
  }
}
