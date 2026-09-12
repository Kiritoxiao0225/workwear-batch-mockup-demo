import { describe, expect, it } from 'vitest';
import { artworkInputSelection, artworkPlanIssues, isReferenceTextArtwork, isTextOnlyArtwork } from './artwork-reference';
import { artworkMethodIssue, standardArtworkPrompts } from './artwork-routing-request';
import { productionArtworkRouting, productionRecipe } from './production-recipe';
import { productionArtworkStage } from './production-preview';
import { artworkProcessingRoute, normalizeTaskReview } from './task-review-analysis';
import { parseArtworkPreparationRequest } from './task-review-artwork';
import { attachProductionArtwork, confirmProductionPlan, emptyWpsProductionState, importTaskReviews, updateProductionPlan } from './wps-production';
import { taskReviewFixture } from './testing/task-review-fixture';
import { artworkQualityFixture } from './testing/artwork-quality-fixture';

function fixture() {
  const review = taskReviewFixture()[0];
  review.source.requirementText = '左胸:XJY\n享聚源\n按照图片稍微设计下\n后背:新鲜直供半斤也是批发价';
  review.units = [{ ...review.units[0], logo: { materialId: null, url: null, name: '' },
    referenceMaterialIds: [review.source.materials[0].id], textMode: 'replace', exactText: 'XJY\n享聚源',
    instruction: '左胸制作“XJY”与“享聚源”，按照图1左胸标识样式稍作设计。',
    layoutNote: '参考图1左胸标识的字形关系、相对大小和排列，不取用人物、服装及其他文字。',
    generationPrompt: '准确文字为上方“XJY”、下方“享聚源”，参考WPS图1左胸标识样式，输出独立文字标识。不得复制原有文字、人物和衣服。纯白背景。',
    ambiguities: ['方案核对：主要内容素材未绑定或已不存在'],
  }];
  const state = importTaskReviews(emptyWpsProductionState(), [review]);
  const unit = state.units[0];
  return { review, source: review.source, state, unit };
}

describe('accurate lettering with reference images only', () => {
  it('imports new analyses with the reference role and no invented content source', () => {
    const { review, source, unit } = fixture();
    expect(normalizeTaskReview(review).units[0].ambiguities).toEqual([]);
    expect(unit.materialId).toBeNull();
    expect(unit.referenceMaterialIds).toEqual([source.materials[0].id]);
    expect(isTextOnlyArtwork(unit)).toBe(false);
    expect(isReferenceTextArtwork(unit)).toBe(true);
    expect(artworkPlanIssues(source, unit)).toEqual([]);
    expect(productionArtworkRouting(unit, source).decision).toMatchObject({ method: 'generate', state: 'ready' });
    const twoImages = { ...source, materials: [...source.materials, { ...source.materials[0], id: 'second-image' }] };
    const selected = artworkInputSelection(twoImages, { ...unit, referenceMaterialIds: ['second-image', source.materials[0].id] });
    expect(selected.primary?.id).toBe(source.materials[0].id);
    expect(selected.referenceMaterialIds).toEqual(['second-image']);
  });

  it('recovers the exact historical blocker at runtime without changing saved fingerprints or evidence', () => {
    const { source, unit } = fixture();
    unit.route = 'blocked';
    unit.ambiguities = ['方案核对：主要内容素材未绑定或已不存在'];
    const before = JSON.stringify(unit);
    expect(artworkProcessingRoute(unit)).toBe('auto');
    expect(productionArtworkStage(unit)).toBe('待制作图案');
    expect(productionArtworkRouting(unit, source).decision).toMatchObject({ method: 'generate', state: 'ready' });
    expect(productionRecipe(unit, source).components.join('\n')).not.toContain('进入成品的内容源');
    expect(JSON.stringify(unit)).toBe(before);
    expect(productionArtworkRouting({ ...unit, ambiguities: [...unit.ambiguities, '方案核对：图号冲突'] }, source).decision.state).toBe('review');
  });

  it('keeps actual missing sources, missing text and missing reference URLs blocked', () => {
    const { source, unit } = fixture();
    expect(artworkPlanIssues(source, { ...unit, referenceMaterialIds: [] })).toContain('主要内容素材未绑定或已不存在');
    expect(artworkPlanIssues(source, { ...unit, exactText: '' })).toContain('主要内容素材未绑定或已不存在');
    expect(productionArtworkRouting(unit, { ...source, materials: [] }).decision.state).toBe('review');
    const unreadable = { ...source, materials: source.materials.map(material => ({ ...material, url: null, previewUrl: null })) };
    expect(productionArtworkRouting(unit, unreadable).decision.state).toBe('review');
    // 候选修复统一了提示词漏图阻塞文案（PROMPT_IMAGE_MISSING），语义不变。
    expect(artworkPlanIssues(source, { ...unit, generationPrompt: '参考图2制作准确文字' }).join()).toContain('制作要求引用图2，但本次没有传入该图');
  });

  it('carries the first reference as a reference through request parsing, model mapping and prompt locking', () => {
    const { unit, source } = fixture();
    const selected = artworkInputSelection(source, unit);
    const input = { ...unit, ...selected, sourceRequirementText: source.requirementText,
      processingRoute: 'auto', printPlacement: undefined,
      image: { dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', fileName: 'reference.png' }, referenceImages: [],
    };
    const parsed = parseArtworkPreparationRequest(input);
    expect(parsed.primaryImageRole).toBe('reference');
    const prompts = standardArtworkPrompts(parsed);
    expect(prompts.imageMapping).toEqual([expect.objectContaining({ sourceLabel: '图1', modelInputLabel: '图1', role: 'reference' })]);
    expect(prompts.generate).toContain('输入图1 = WPS 图1（参考素材）');
    expect(prompts.generate).toContain('唯一允许出现的文字');
    expect(prompts.generate).not.toContain('内容素材');
    expect(prompts.hash).not.toBe(standardArtworkPrompts({ ...parsed, primaryImageRole: 'content' }).hash);
    expect(artworkMethodIssue(parsed, 'preserve')).toBeTruthy();
    expect(artworkMethodIssue(parsed, 'compose')).toBeTruthy();
    // 候选修复新增保护（与其自带测试「不确定位置不静默读取所有位置」一致）：本输入未携带印花位置，
    // 而原文同时包含左胸与后背两个位置分支，不能静默读取所有位置的要求，generate 也必须先明确分支。
    expect(artworkMethodIssue(parsed, 'generate')).toContain('原文包含多个款式或位置分支');
    expect(() => parseArtworkPreparationRequest({ ...input, exactText: '' })).toThrow('准确文字');
    expect(() => parseArtworkPreparationRequest({ ...input, generationPrompt: '' })).toThrow('生图提示词');
  });

  it('saves an existing blocked unit without changing its source role and rejects vanished reference assets', () => {
    const { state, unit } = fixture();
    unit.route = 'blocked';
    unit.ambiguities = ['方案核对：主要内容素材未绑定或已不存在'];
    const checkedAt = new Date().toISOString();
    const sha256 = 'a'.repeat(64);
    const input = { url: '/uploads/logos/reference-text.png', name: 'reference-text.png', service: 'auto' as const, requestSummary: '文字与样式参考回归验证',
      validation: { valid: true, mimeType: 'image/png' as const, width: 1000, height: 600, byteLength: 1000, sha256,
        quality: artworkQualityFixture(sha256), transparentPixelRatio: 0.5, visiblePixelRatio: 0.5, checkedAt, ruleVersion: 'transparent-artwork-v1' as const, issues: [] },
    };
    const saved = attachProductionArtwork(state, unit.id, input, 'reference-test');
    expect(saved.units[0].artwork?.url).toBe(input.url);
    expect(saved.units[0].materialId).toBeNull();
    expect(saved.units[0].recipeFingerprint).toBe(unit.recipeFingerprint);
    expect(() => confirmProductionPlan(saved, unit.id, 'test')).not.toThrow();
    const edited = updateProductionPlan(state, unit.id, { generationPrompt: unit.generationPrompt });
    expect(edited.units[0].ambiguities).toEqual([]);
    state.records[0].source.materials = [];
    expect(() => attachProductionArtwork(state, unit.id, input, 'missing-reference')).toThrow('参考');
  });
});
