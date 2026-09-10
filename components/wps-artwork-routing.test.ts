import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews, updateProductionPlan } from '@/lib/wps-production';
import { productionArtworkRouting, productionRecipe } from '@/lib/production-recipe';
import { WpsArtworkMethodSelector, WpsArtworkRouting } from './wps-artwork-routing';

function setup() {
  const review = taskReviewFixture()[0];
  review.source.requirementText = '左胸：图一';
  review.units = [{ ...review.units[0], instruction: '左胸使用图1原图案', layoutNote: '', exactText: '', textMode: 'keep',
    logo: { materialId: review.source.materials[0].id, name: '图1', url: null }, referenceMaterialIds: [], sourceScope: 'subject',
    sourceAssessment: { version: 'artwork-source-v1', kind: 'artwork-on-object', needsReconstruction: true,
      targetDescription: '衣物胸口的红色文字与标志', evidence: ['胸标位于有褶皱的衣物上'], uncertainDetails: ['部分字形不清'] } }];
  const state = importTaskReviews(emptyWpsProductionState(), [review]);
  return { source: review.source, state, unit: state.units[0] };
}

it('shows the same B decision as execution, disables unsuitable preservation, and explains target reconstruction', () => {
  const { unit, source } = setup();
  expect(productionArtworkRouting(unit, source).decision.method).toBe('redraw');
  expect(productionRecipe(unit, source).title).toContain('按原设计重建');
  const html = renderToStaticMarkup(createElement(WpsArtworkMethodSelector, { unit, source, busy: false, change: vi.fn() }));
  expect(html).toContain('自动推荐 · 原设计重建');
  expect(html).toMatch(/<option[^>]*disabled=""[^>]*value="preserve"|<option[^>]*value="preserve"[^>]*disabled=""/u);
  expect(renderToStaticMarkup(createElement(WpsArtworkRouting, { unit, source }))).toContain('胸标位于有褶皱的衣物上');
});

it('does not describe legacy uninspected sources as original-fidelity work', () => {
  const { unit, source } = setup(); delete unit.sourceAssessment;
  expect(productionArtworkRouting(unit, source).decision).toMatchObject({ method: null, state: 'pending' });
  expect(productionRecipe(unit, source).title).toContain('识别目标');
});

it('retains source evidence across placement edits and invalidates it when the target or material changes', () => {
  const { unit, state } = setup();
  expect(updateProductionPlan(state, unit.id, { placement: unit.placement }).units[0].sourceAssessment).toEqual(unit.sourceAssessment);
  const changed = updateProductionPlan(state, unit.id, { instruction: '提取图1另一个标志' }).units[0];
  expect(changed.sourceAssessment).toBeUndefined();
  expect(changed.recipeFingerprint).not.toBe(unit.recipeFingerprint);
});
