import sharp from 'sharp';
import { artworkInputSelection, artworkPlanIssues, isTextOnlyArtwork } from '@/lib/artwork-reference';
import { assertProductionArtworkSnapshot } from '@/lib/production-artwork-snapshot';
import { productionArtworkRouting } from '@/lib/production-recipe';
import { artworkProcessingRoute } from '@/lib/task-review-analysis';
import { standardArtworkPrompts } from '@/lib/artwork-routing-request';
import { artworkPrintPlacement } from '@/lib/production-artwork-layout';
import { parseArtworkPreparationRequest, type ArtworkPreparationResponse } from '@/lib/task-review-artwork';
import { attachProductionArtwork } from '@/lib/wps-production';
import { requestedProductionTextColor } from '@/lib/production-text-color';
import { persistProductionReferences, readProductionFile } from './production-storage';
import { readWpsProductionState, mutateWpsProductionState } from './wps-production-store';
import { completedProductionSave } from './production-cloud-state';
import { validateProductionArtworkDraft } from './production-artwork-quality';
import { finishProductionSave } from './production-post-save';
import { NativeArtworkCandidateError, prepareStandardArtwork } from './artwork-standard-pipeline';
import { durableArtworkServices } from './artwork-job-services';
import { artworkJobStep, saveArtworkJobFile, artworkStepHash, inArtworkJob, withArtworkStage } from './artwork-job-runtime';
import { updateArtworkJob, type ArtworkJob } from './artwork-job-store';
import { catalogDatabase } from './catalog-database';
import { prepareServerPrintedArtwork, serverProductionTextColor, serverProductionTextDraft } from './render-artwork';

async function modelInput(url: string, fileName: string) {
  const bytes = await readProductionFile(url);
  const png = await sharp(bytes, { limitInputPixels: 32_000_000 }).rotate().png().toBuffer();
  if (png.length > 8 * 1024 * 1024) throw new Error('主要素材大于 8MB，请先缩小素材');
  return { fileName, mimeType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}
export async function processArtworkJob(job: ArtworkJob) {
  return inArtworkJob(job, async () => {
    // Saving is idempotent even if a worker dies after committing the production state.
    const receipt = { id: job.id, hash: artworkStepHash({ unitId: job.unit_id, snapshot: job.snapshot }) };
    try {
      if (await completedProductionSave(receipt)) { await updateArtworkJob(job, 'completed', '图案已保存，请核对'); return; }
      const current = await readWpsProductionState();
      assertProductionArtworkSnapshot(current, job.unit_id, job.snapshot);
      const { unit, source } = job.input;
      const textOnly = isTextOnlyArtwork(unit);
      const issue = artworkPlanIssues(source, unit).join('；');
      if (issue) throw new Error(issue);
      const selection = artworkInputSelection(source, unit);
      let result: ArtworkPreparationResponse | null = null;
      let inputImageUrls: string[] = [];
      if (!textOnly) {
        if (!selection.primary) throw new Error('缺少主要素材');
        const materials = [selection.primary, ...selection.referenceMaterialIds.map(id => {
          const material = source.materials.find(material => material.id === id);
          if (!material) throw new Error(`找不到参考素材 ${id}`);
          return material;
        })];
        inputImageUrls = materials.map(material => {
          const url = material.url ?? material.previewUrl;
          if (!url) throw new Error('素材没有可读取的图片');
          return url;
        });
        const images = await Promise.all(materials.map((material, i) => modelInput(inputImageUrls[i], material.name || `图${i + 1}.png`)));
        const request = parseArtworkPreparationRequest({ sourceRequirementText: source.requirementText, printPlacement: artworkPrintPlacement(unit.placement),
          instruction: unit.instruction, generationPrompt: unit.generationPrompt, sourceAssessment: productionArtworkRouting(unit, source).facts.sourceAssessment,
          exactText: unit.textMode === 'replace' ? unit.exactText : '', layoutNote: unit.layoutNote,
          image: images[0], primaryImageLabel: selection.primaryImageLabel, primaryImageRole: selection.primaryImageRole,
          referenceImages: materials.slice(1).map((material, i) => ({ label: `图${source.materials.findIndex(item => item.id === material.id) + 1}`, image: images[i + 1] })),
          artworkMethod: unit.artworkMethod, cutoutMode: unit.cutoutMode ?? 'auto', enhancementMode: 'auto', sourceScope: unit.sourceScope,
          processingRoute: artworkProcessingRoute(unit) === 'deterministic' ? 'fidelity' : artworkProcessingRoute(unit) });
        const prompt = standardArtworkPrompts(request);
        result = await prepareStandardArtwork({ ...request, expectedPromptVersion: prompt.version, expectedPromptHash: prompt.hash }, durableArtworkServices());
      }
      await withArtworkStage('processing', async () => {
        let draft = result?.draft ?? await serverProductionTextDraft(unit, requestedProductionTextColor(unit) ?? await serverProductionTextColor(unit));
        if (draft.text && !requestedProductionTextColor(unit)) {
          const color = await serverProductionTextColor(unit);
          draft = { ...draft, text: { ...draft.text, color }, extraTexts: draft.extraTexts?.map(text => ({ ...text, color })) };
        }
        draft = await persistProductionReferences(draft);
        const layout = await artworkJobStep('layout', 'processing', { draft, placement: unit.placement }, async () => {
          if (result?.preprocessing.modelLayoutPreserved) return { draft, url: draft.graphic.sourceUrl, automaticWidthCm: undefined,
            summary: '保留模型字体与排版；透明图案按位置标准确定印花尺寸。' };
          const fitted = await prepareServerPrintedArtwork(draft, unit);
          const file = await saveArtworkJobFile(fitted.rendered.bytes, `${unit.id}-artwork.png`);
          return { draft: fitted.draft, url: file.url, automaticWidthCm: fitted.automaticWidthCm, summary: fitted.summary };
        });
        const { validation, draft: verified } = await validateProductionArtworkDraft(layout.url, layout.draft, unit.artwork?.validation, unit.artwork?.draft);
        const service = textOnly ? 'deterministic' : artworkProcessingRoute(unit);
        if (service === 'blocked') throw new Error('制作路线仍待核对');
        const latest = await readWpsProductionState();
        await mutateWpsProductionState(latest.revision, state => attachProductionArtwork(state, unit.id, {
          url: layout.url, name: `${unit.id}-artwork.png`, validation, draft: verified, automaticWidthCm: layout.automaticWidthCm ?? undefined,
          service, inputImageUrls, prompt: result?.preprocessing.resolvedPrompt ?? null, promptHash: result?.preprocessing.promptHash ?? null,
          requestSummary: textOnly ? `程序文字排版：${unit.exactText}；抖音美好体。${layout.summary}` : `${layout.summary} ${result!.preprocessing.decisionRule}`,
          providerTaskId: job.id, estimatedCostCny: 0, actualCostCny: null,
        }, job.id), state => assertProductionArtworkSnapshot(state, unit.id, job.snapshot), receipt);
      });
      await updateArtworkJob(job, 'completed', '图案已保存，请核对');
      // Customer preview failure must never turn a saved artwork back into a failed paid job.
      await finishProductionSave({ action: 'submitArtwork', unitId: job.unit_id }).catch(error => console.error('[artwork-worker] preview update failed', error instanceof Error ? error.name : 'Error'));
    } catch (error) {
      const steps = (await catalogDatabase().query('SELECT status FROM artwork_job_steps WHERE job_id=$1', [job.id])).rows;
      const unknown = steps.some(step => step.status === 'unknown');
      const candidate = error instanceof NativeArtworkCandidateError ? await persistProductionReferences(error.candidate) : null;
      const failed = steps.some(step => step.status === 'failed');
      const message = error instanceof Error ? error.message : String(error);
      await updateArtworkJob(job, unknown ? 'unknown' : candidate && !failed ? 'review' : 'failed',
        unknown ? '生图结果不确定，请核对原任务' : candidate && !failed ? '图案需要核对，已保留图片' : '处理未完成，可从已保存步骤继续', message.slice(0, 4000), candidate);
    }
  });
}
