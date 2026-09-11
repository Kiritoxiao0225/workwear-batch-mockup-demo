import { describe, expect, it } from 'vitest';
import { productionArtworkRouting, productionRecipe } from '@/lib/production-recipe';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews, updateProductionPlan } from '@/lib/wps-production';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import type { ArtworkRoutingReport } from '@/lib/artwork-routing-standard';

const flatAssessment = { version: 'artwork-source-v1' as const, kind: 'flat-artwork' as const, targetDescription: '独立平面 Logo', needsReconstruction: false, evidence: ['测试素材为独立平面图案'], uncertainDetails: [] };
describe('production recipe explanations', () => {
  it('explains replacement separately without changing the historical add-text mode', () => {
    const review = taskReviewFixture()[0];
    const unit = { ...importTaskReviews(emptyWpsProductionState(), [review]).units[0], sourceAssessment: flatAssessment,
      textMode: 'replace' as const, exactText: '康悦', layoutNote: '', instruction: '将原文字替换为康悦' };
    expect(productionRecipe(unit, review.source).title).toBe('清除指定旧字＋准确文字替换');
    expect(productionRecipe(unit, review.source).reason).toContain('先清除指定旧字');
    expect(productionRecipe({ ...unit, instruction: '保留原字，新增康悦' }, review.source).title).not.toContain('清除');
  });
  it('distinguishes a preflight plan from measured processing and preserves WPS image numbers', () => {
    const review = taskReviewFixture()[1];
    const state = importTaskReviews(emptyWpsProductionState(), [review]);
    const unit = state.units.find(unit => unit.materialId === 'snapshot-02-m5')!;
    const clarified = (layoutNote: string) => ({ ...updateProductionPlan(state, unit.id, { layoutNote }).units.find(candidate => candidate.id === unit.id)!, sourceAssessment: flatAssessment });
    const layoutUnit = clarified('按照图4的整体排版');
    const recipe = productionRecipe(layoutUnit, review.source);
    expect(recipe.title).toBe('模型生成完整图案');
    expect(recipe.components.join(' ')).toContain('图5');
    expect(recipe.components.join(' ')).toContain('图4：仅作参考');
    expect(recipe.actualLabel).toBeNull();
    expect(productionRecipe(clarified('只参考图4字体'), review.source).title).toBe('保真主体＋模型文字');
    expect(productionRecipe({ ...layoutUnit, route: 'gpt-image-2' }, review.source).title).toContain('GPT Image 2');
    expect(productionRecipe({ ...unit, route: 'gpt-image-2' }, review.source).title).toContain('先核对');
  });
  it('does not invent a measured enhancement tier or mislabel a missing source as image zero', () => {
    const review = taskReviewFixture()[0];
    const unit = importTaskReviews(emptyWpsProductionState(), [review]).units[0];
    unit.sourceAssessment = flatAssessment;
    const recipe = productionRecipe(unit, review.source);
    expect(recipe.reason).toContain('检测原图后确定');
    expect(recipe.actualLabel).toBeNull();
    expect(productionRecipe({ ...unit, materialId: null }, review.source).components.join(' ')).not.toContain('图0');
  });
});

describe('production routing evidence', () => {
  const review = taskReviewFixture()[0];
  const imported = importTaskReviews(emptyWpsProductionState(), [review]).units[0];
  const unit = { ...imported, sourceAssessment: flatAssessment, textMode: 'keep' as const, exactText: '', instruction: '保留图1原样', layoutNote: '', referenceMaterialIds: [], ambiguities: [] };

  it('does not treat merely attaching a reference, negated design intent or crop as whole generation', () => {
    expect(productionArtworkRouting({ ...unit, referenceMaterialIds: [review.source.materials[0].id] }, review.source).decision.method).toBe('preserve');
    expect(productionArtworkRouting({ ...unit, instruction: '不要重新设计，保留原图' }, review.source).decision.method).toBe('preserve');
    expect(productionArtworkRouting({ ...unit, instruction: '截取图1前三排' }, review.source).decision).toMatchObject({ method: 'compose', state: 'review' });
  });
  it('detects whole reference layout without requiring added text', () => {
    const source = { ...review.source, materials: [...review.source.materials, { ...review.source.materials[0], id: 'layout-reference' }] };
    const decision = productionArtworkRouting({ ...unit, layoutNote: `按照图${source.materials.length}整体排版`, referenceMaterialIds: ['layout-reference'] }, source).decision;
    expect(decision.method).toBe('generate');
  });
  it('does not let a saved C report override a newly detected missing source reference', () => {
    const source = { ...review.source, requirementText: '左胸：图1加文字，排版参考图2', materials: [...review.source.materials, { ...review.source.materials[0], id: 'layout-reference' }] };
    const draft = createLegacyArtworkDraft('/original.png');
    const base = productionArtworkRouting(unit, review.source);
    const quality = artworkQualityFixture('a'.repeat(64));
    draft.preprocessing.routingReport = { facts: base.facts, source: quality, graphic: quality, repair: null, decision: { ...base.decision, method: 'compose', state: 'ready', action: 'compose' } } as ArtworkRoutingReport;
    const candidate = { ...unit, artwork: { draft, url: '/result.png', name: 'test', recipeFingerprint: unit.recipeFingerprint, createdAt: '2026-09-07T00:00:00Z', validation: { valid: true } } } as typeof unit;
    const result = productionArtworkRouting(candidate, source);
    expect(result.decision).toMatchObject({ method: null, state: 'review' });
    expect(result.facts.blockers.join(' ')).toContain('参考图2');
  });
  it('does not silently interpret an empty replacement text as preservation', () => {
    expect(productionArtworkRouting({ ...unit, textMode: 'replace' }, review.source).decision).toMatchObject({ method: 'compose', state: 'review' });
  });
  it('treats AI doubts as reminders, including saved routes blocked by white-background doubts', () => {
    expect(productionArtworkRouting({ ...unit, ambiguities: ['未明确说明货号对应冲锋衣还是POLO衫'] }, review.source).decision.method).toBe('preserve');
    expect(productionArtworkRouting({ ...unit, ambiguities: ['图中文字无法确认'] }, review.source).decision.method).toBe('preserve');
    const saved = { ...unit, route: 'blocked' as const, generationPrompt: '保留图1的原设计，输出纯白背景 PNG。', ambiguities: ['图案为白色或近白色，纯白背景无法分离，需确认颜色。'] };
    expect(productionArtworkRouting(saved, review.source).decision.method).toBe('preserve');
    expect(productionRecipe(saved, review.source).title).toContain('保留 Logo 图形并去底');
    expect(productionArtworkRouting({ ...saved, materialId: null }, review.source).decision.state).toBe('review');
    expect(productionArtworkRouting({ ...saved, ambiguities: ['方案核对：参考图2缺失'] }, review.source).decision.state).toBe('review');
  });
  it('never presents historical source blur as a post-repair or standardized score', () => {
    const draft = createLegacyArtworkDraft('/original.png');
    draft.preprocessing = { ...draft.preprocessing, blurScore: 47.62, qualityScore: 72.98, enhancement: 'professional', requiredScale: 2.09 };
    const candidate = { ...unit, artwork: { draft, url: '/result.png', name: 'test', recipeFingerprint: unit.recipeFingerprint, createdAt: '2026-09-07T00:00:00Z', validation: { valid: true } } } as typeof unit;
    const result = productionArtworkRouting(candidate, review.source);
    expect(result.historicalClarity).toBe(47.62);
    expect(result.decision).toMatchObject({ method: 'preserve', action: 'clean' });
    expect(result.decision.checks.some(check => check.label.includes('清晰度'))).toBe(false);
    expect(productionArtworkRouting({ ...candidate, recipeFingerprint: 'changed' }, review.source).historicalClarity).toBeNull();
  });
  it('does not promote a reversed-score historical redraw decision as a current recommendation', () => {
    const draft = createLegacyArtworkDraft('/original.png');
    const base = productionArtworkRouting(unit, review.source);
    const oldQuality = artworkQualityFixture('a'.repeat(64), { score: 2.56, protocol: 'foreground-white-1000-v1' });
    const report = { facts: base.facts, source: oldQuality, graphic: oldQuality,
      decision: { ...base.decision, method: 'redraw', state: 'ready', action: 'redraw' } } as ArtworkRoutingReport;
    draft.preprocessing.routingReport = report;
    const candidate = { ...unit, artwork: { draft, url: '/result.png', name: 'test', recipeFingerprint: unit.recipeFingerprint, createdAt: '2026-09-07T00:00:00Z', validation: { valid: true } } } as typeof unit;
    const result = productionArtworkRouting(candidate, review.source);
    expect(result.decision).toMatchObject({ method: 'preserve', state: 'ready', action: 'clean' });
    expect(result.report).toBe(report);
    expect(report.decision.action).toBe('redraw');
  });
});
