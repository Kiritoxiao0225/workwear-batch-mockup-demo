import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { artworkFontReferenceSchema, fontReferenceInput, resolveFontReferenceText, type ArtworkFontReference } from './artwork-font-reference';
import { artworkInputSelection, artworkPlanIssues, isTextOnlyArtwork } from './artwork-reference';
import { normalizeTaskReview } from './task-review-analysis';
import { standardArtworkPrompts, artworkRequirementFacts } from './artwork-routing-request';
import { parseArtworkPreparationRequest } from './task-review-artwork';
import { taskReviewFixture } from './testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews, updateProductionPlan } from './wps-production';
import { productionArtworkSnapshot } from './production-artwork-snapshot';
import { cropArtworkFontInput } from './server/artwork-font-reference';

function fixture() {
  const review = taskReviewFixture()[2];
  const fontReference: ArtworkFontReference = { materialId: review.source.materials[1].id, origin: 'visual',
    evidence: '图2中可见后背文字，与订单后背位置对应', description: '上方一行粗体文字，笔画宽、收笔平直', region: { x: .2, y: .3, width: .6, height: .2 } };
  review.source.requirementText = '左胸:logo 后背:测试文字 字体: 颜色: 工艺: 尺寸:';
  const unit = review.units[1];
  Object.assign(unit, { fontReference, logo: { materialId: null, url: null, name: '' }, referenceMaterialIds: [fontReference.materialId],
    textMode: 'replace', exactText: '测试文字', instruction: '后背制作文字测试文字', layoutNote: '', generationPrompt: '只制作测试文字，字体参考图2。', ambiguities: [] });
  return { review, fontReference };
}

describe('structured font references', () => {
  it('preserves a visual font suggestion when the source only specifies literal back text', () => {
    const { review, fontReference } = fixture();
    const result = normalizeTaskReview(review).units[1];
    expect(result.fontReference).toEqual(fontReference);
    expect(result.referenceMaterialIds).toContain(fontReference.materialId);
    expect(result.generationPrompt).toContain('字体参考图2');
    expect(isTextOnlyArtwork({ ...result, materialId: result.logo.materialId })).toBe(false);
    expect(normalizeTaskReview(review).units[0].fontReference).toBeUndefined();
  });
  it('restores the role if analysis incorrectly calls the font reference a content image', () => {
    const { review, fontReference } = fixture();
    review.units[1].logo.materialId = fontReference.materialId;
    const result = normalizeTaskReview(review).units[1];
    expect(result.logo.materialId).toBeNull();
    expect(result.referenceMaterialIds).toContain(fontReference.materialId);
  });
  it('persists crop and evidence, changes recipe and snapshot when the font crop changes, and preserves the old image', () => {
    const { review, fontReference } = fixture();
    let state = importTaskReviews(emptyWpsProductionState(), [review]);
    const unit = state.units[1];
    expect(JSON.parse(JSON.stringify(unit)).fontReference).toEqual(fontReference);
    const previous = { url: 'old.png', name: 'old', recipeFingerprint: unit.recipeFingerprint, createdAt: unit.updatedAt, validation: { sha256: 'old' } } as NonNullable<typeof unit.artwork>;
    unit.artwork = previous;
    const snapshot = productionArtworkSnapshot(unit, state.records[0].source);
    state = updateProductionPlan(state, unit.id, { fontReference: { ...fontReference, origin: 'manual', region: { x: .1, y: .2, width: .8, height: .3 } } });
    const saved = state.units[1];
    expect(saved.recipeFingerprint).not.toBe(unit.recipeFingerprint);
    expect(saved.generationPrompt).toBeUndefined();
    expect(saved.artwork).toBeNull();
    expect(saved.previousArtwork?.url).toBe('old.png');
    expect(productionArtworkSnapshot(saved, state.records[0].source)).not.toBe(snapshot);
    expect(state.units[0].recipeFingerprint).toBe(importTaskReviews(emptyWpsProductionState(), [review]).units[0].recipeFingerprint);
  });
  it('rejects a missing reference, inconsistent role, missing exact text and an out-of-image crop', () => {
    const { review, fontReference } = fixture();
    const unit = importTaskReviews(emptyWpsProductionState(), [review]).units[1];
    expect(artworkPlanIssues(review.source, { ...unit, referenceMaterialIds: [] })).toContain('字体参考图尚未绑定为参考素材');
    expect(artworkPlanIssues(review.source, { ...unit, exactText: '' })).toContain('仿字体需要填写准确文字');
    expect(artworkPlanIssues(review.source, { ...unit, materialId: fontReference.materialId })).toContain('字体参考不能同时作为主要内容图');
    expect(() => fontReferenceInput(review.source, { fontReference: { ...fontReference, materialId: 'missing' } })).toThrow('已不存在');
    expect(() => artworkFontReferenceSchema.parse({ ...fontReference, region: { x: .9, y: 0, width: .2, height: .1 } })).toThrow();
  });
  it('binds model input 1 to customer image 2 and generates text even without a prose prompt', async () => {
    const { review } = fixture();
    const unit = importTaskReviews(emptyWpsProductionState(), [review]).units[1];
    const selection = artworkInputSelection(review.source, unit);
    const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toBuffer();
    const request = parseArtworkPreparationRequest({ image: { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, mimeType: 'image/png', fileName: 'font.png' },
      sourceRequirementText: review.source.requirementText, instruction: unit.instruction, exactText: unit.exactText,
      primaryImageRole: selection.primaryImageRole, primaryImageLabel: selection.primaryImageLabel, fontReference: fontReferenceInput(review.source, unit) });
    const prompts = standardArtworkPrompts(request);
    expect(prompts.generate).toContain('输入图1 = WPS 图2（参考素材）');
    expect(prompts.generate).toContain('字体参考 WPS 图2的文字裁片');
    expect(prompts.generate).not.toContain('内容素材');
    expect(artworkRequirementFacts(request).intent).toBe('generate');
    expect(prompts.imageMapping).toEqual([expect.objectContaining({ sourceLabel: '图2', role: 'reference', requirement: expect.stringContaining('字体参考裁片') })]);
    const cropped = await cropArtworkFontInput(request);
    const actual = await sharp(Buffer.from(cropped.image.dataUrl.split(',')[1], 'base64')).metadata();
    expect(actual.width).toBe(60); expect(actual.height).toBe(20);
    expect(request.image.dataUrl).not.toBe(cropped.image.dataUrl);
  });
  it('applies a manual font change without retaining the previous font number or changing color references', () => {
    const { review } = fixture();
    const unit = importTaskReviews(emptyWpsProductionState(), [review]).units[1];
    unit.fontReference = { ...unit.fontReference!, materialId: review.source.materials[0].id, origin: 'manual' };
    unit.referenceMaterialIds = [unit.fontReference.materialId];
    unit.instruction = '后背制作测试文字，字体参考图2'; unit.generationPrompt = undefined;
    review.source.requirementText = '后背：测试文字，字体参考图二';
    expect(artworkPlanIssues(review.source, unit)).toEqual([]);
    const reference = fontReferenceInput(review.source, unit)!;
    expect(resolveFontReferenceText('字体参考图2；颜色参考图2；保留图2标志', reference)).toBe('字体参考图1；颜色参考图2；保留图2标志');
    const prompt = standardArtworkPrompts({ fontReference: reference, primaryImageRole: 'reference', primaryImageLabel: '图1', exactText: unit.exactText,
      instruction: unit.instruction, layoutNote: '', sourceRequirementText: review.source.requirementText, referenceImages: [], sourceScope: 'subject', processingRoute: 'auto' });
    expect(prompt.generate).toContain('字体参考图1');
    expect(prompt.generate).not.toContain('字体参考图2');
  });
  it('changes the prompt hash when the reference region changes', () => {
    const { review } = fixture();
    const unit = importTaskReviews(emptyWpsProductionState(), [review]).units[1];
    const input = { fontReference: fontReferenceInput(review.source, unit), primaryImageRole: 'reference' as const, primaryImageLabel: '图2',
      exactText: unit.exactText, instruction: unit.instruction, layoutNote: '', sourceRequirementText: review.source.requirementText,
      referenceImages: [], sourceScope: 'subject' as const, processingRoute: 'auto' as const };
    expect(standardArtworkPrompts(input).hash).not.toBe(standardArtworkPrompts({ ...input, fontReference: { ...input.fontReference!, region: { x: .1, y: .1, width: .4, height: .4 } } }).hash);
  });
});
