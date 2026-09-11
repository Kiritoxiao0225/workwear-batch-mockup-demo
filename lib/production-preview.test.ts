import { describe, expect, it } from 'vitest';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { initialTaskPlacement, taskPlacementAnchor, productionArtworkStage, productionPreviewRevision, productionPreviewCalibrationKey, reuseProductionGeometry } from '@/lib/production-preview';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import {
  attachProductionArtwork,
  beginGptImage2Attempt,
  confirmProductionArtwork,
  emptyWpsProductionState,
  importTaskReviews,
  updateProductionAttempt,
  updateProductionPlan,
  type ArtworkValidation,
  type AttemptStatus,
} from '@/lib/wps-production';

const now = new Date('2026-09-05T00:00:00.000Z');

describe('preview geometry across background refreshes', () => {
  it('preserves measured scale across a sync, but never carries it to another image or crop', () => {
    const current = initialState(); current.units[0].garment = garmentFixture();
    current.units[0].garment.views.forEach(view => { view.bodyScale = { widthRatio: .5, basis: 'alpha-torso-v1' }; });
    const incoming = structuredClone(current);
    incoming.units[0].garment!.views.forEach(view => { delete view.bodyScale; });
    incoming.units[0].instruction = 'new instruction from the server';
    const merged = reuseProductionGeometry(incoming, current);
    expect(merged.units[0].garment!.views[0].bodyScale?.widthRatio).toBe(.5);
    expect(merged.units[0].instruction).toBe(incoming.units[0].instruction);
    expect(incoming.units[0].garment!.views[0].bodyScale).toBeUndefined();
    const changed = structuredClone(incoming); changed.units[0].garment!.sha256 = 'f'.repeat(64);
    expect(reuseProductionGeometry(changed, current).units[0].garment!.views[0].bodyScale).toBeUndefined();
    incoming.units[0].garment!.views[0].crop.x += .01;
    expect(reuseProductionGeometry(incoming, current).units[0].garment!.views[0].bodyScale).toBeUndefined();
  });
});

function initialState() {
  return importTaskReviews(emptyWpsProductionState(now), [taskReviewFixture()[0]], now);
}

function attemptState(status: AttemptStatus) {
  let state = initialState();
  const unitId = state.units[0].id;
  state = updateProductionPlan(state, unitId, { route: 'gpt-image-2' }, now);
  state = beginGptImage2Attempt(state, unitId, {
    attemptId: 'current-attempt', requestSummary: '测试任务，不调用供应商',
    inputImageUrls: ['/test-source.png'], prompt: 'test prompt', promptHash: 'test-hash', estimatedCostCny: 1,
  }, now);
  return updateProductionAttempt(state, unitId, 'current-attempt', {
    status, error: status === 'failed' ? '供应商处理失败' : null,
  }, now);
}

function artworkState(valid = true) {
  const state = initialState();
  const validation: ArtworkValidation = {
    valid, mimeType: 'image/png', width: 800, height: 600, byteLength: 1000,
    sha256: 'a'.repeat(64), transparentPixelRatio: 0.5, visiblePixelRatio: 0.5,
    quality: artworkQualityFixture('a'.repeat(64)),
    checkedAt: now.toISOString(), ruleVersion: 'transparent-artwork-v1',
    issues: valid ? [] : ['图片没有有效透明区域'],
  };
  return attachProductionArtwork(state, state.units[0].id, {
    url: '/uploads/logos/test.png', name: 'test.png', validation,
    service: 'auto', requestSummary: '测试制作，不调用外部服务',
  }, 'artwork-attempt', now);
}

describe('production artwork stage', () => {
  it('keeps other garments preview URLs stable when a task is saved, and changes the edited garment URL', () => {
    const state = importTaskReviews(emptyWpsProductionState(now), [taskReviewFixture()[0], taskReviewFixture()[2]], now);
    const target = state.units[0];
    const edited = updateProductionPlan(state, target.id, { instruction: `${target.instruction} 已修改` }, new Date(now.getTime() + 1000));
    for (const version of state.mockupVersions) {
      const updated = edited.mockupVersions.find(candidate => candidate.id === version.id)!;
      const before = productionPreviewRevision(version, state.units);
      const after = productionPreviewRevision(updated, edited.units);
      if (version.unitIds.includes(target.id)) expect(after).not.toBe(before);
      else expect(after).toBe(before);
    }
  });

  it.each([
    ['queued', '图案待处理'],
    ['submitted', '已提交，等待处理'],
    ['processing', '正在处理图案'],
    ['unknownSubmission', '提交状态待核实'],
    ['failed', '图案处理失败'],
  ] as const)('shows %s attempts instead of inviting another generation', (status, label) => {
    expect(productionArtworkStage(attemptState(status).units[0])).toBe(label);
  });

  it('shows a failed PNG check as a failure even though no artwork was saved', () => {
    const unit = artworkState(false).units[0];
    expect(unit.artwork).toBeNull();
    expect(productionArtworkStage(unit)).toBe('图案处理失败');
  });

  it('uses the latest current attempt after a failed generation is retried', () => {
    let state = attemptState('failed');
    state = beginGptImage2Attempt(state, state.units[0].id, {
      attemptId: 'retry-attempt', requestSummary: '测试重试', inputImageUrls: ['/test-source.png'],
      prompt: 'test prompt', promptHash: 'test-hash', estimatedCostCny: 1,
    }, now);
    expect(productionArtworkStage(state.units[0])).toBe('图案待处理');
  });

  it.each(['processing', 'failed', 'completed'] as const)('does not reuse %s status from an old recipe', status => {
    let state = attemptState(status);
    state = updateProductionPlan(state, state.units[0].id, { layoutNote: '图案改为横向排版' }, now);
    expect(productionArtworkStage(state.units[0])).toBe('图案要求已更新，需重新制作');
  });

  it('does not describe an artwork from an old recipe as confirmed', () => {
    let state = artworkState();
    state = confirmProductionArtwork(state, state.units[0].id, '测试员', now);
    expect(productionArtworkStage({ ...state.units[0], recipeFingerprint: 'new-recipe' })).toBe('图案要求已更新，需重新制作');
  });

  it('distinguishes missing source material from a completed attempt with no saved file', () => {
    expect(productionArtworkStage({ ...initialState().units[0], materialId: null })).toBe('缺少原始素材');
    expect(productionArtworkStage(attemptState('completed').units[0])).toBe('图案文件缺失，需重新制作');
  });

  it('keeps independent artwork preparation available before garment and position choices', () => {
    let state = initialState();
    state = updateProductionPlan(state, state.units[0].id, {
      garment: null, placement: null, ambiguities: ['衣服款式与货号待确认'],
    }, now);
    expect(state.units[0].gateA).toBeNull();
    expect(productionArtworkStage(state.units[0])).toBe('待制作图案');
    expect(productionArtworkStage({ ...state.units[0], ambiguities: ['原图准确文字待确认'] })).toBe('待制作图案');
    expect(productionArtworkStage({ ...state.units[0], ambiguities: ['方案核对：参考素材已不存在'] })).toBe('待补充图案要求');
  });

  it('requires confirmation of the current PNG without requiring confirmed garment placement', () => {
    let state = artworkState();
    expect(productionArtworkStage(state.units[0])).toBe('待核对 Logo');
    state = confirmProductionArtwork(state, state.units[0].id, '测试员', now);
    const unit = state.units[0];
    expect(unit.gateA).toBeNull();
    expect(productionArtworkStage(unit)).toBe('Logo 已确认');
    expect(productionArtworkStage({ ...unit, gateB: { ...unit.gateB!, fingerprint: 'old-image-sha' } })).toBe('待核对 Logo');
  });
});


describe('garment position markers', () => {
  it('shows position markers before body measurements load without fabricating dimensions', () => {
    const unit = initialState().units[0];
    const garment = { ...garmentFixture(), views: garmentFixture().views.map(view => ({ ...view, bodyScale: undefined, standard: null })) };
    const candidate = { ...unit, garment };
    expect(taskPlacementAnchor(candidate)).toEqual({ centerX: .64, centerY: .34 });
    expect(() => initialTaskPlacement(candidate, { width: 1, height: 1 })).toThrow('无法确定衣身宽度');
    expect(candidate.garment.views.every(view => !view.bodyScale)).toBe(true);
  });
  it('uses the exact same saved anchor for table markers and the artwork canvas', () => {
    const unit = initialState().units[0];
    const candidate = { ...unit, garment: garmentFixture(), placement: { ...unit.placement!, manual: { centerX: .61, centerY: .32, width: .1 } } };
    expect(taskPlacementAnchor(candidate)).toEqual({ centerX: .61, centerY: .32 });
    expect(initialTaskPlacement(candidate, { width: 1, height: 1 }).manual).toMatchObject(taskPlacementAnchor(candidate));
  });
});

it('re-reads a newly calibrated preview without changing the persisted task revision guard', () => {
  const state = initialState(); state.units[0].garment = garmentFixture();
  const before = productionPreviewCalibrationKey(state.units), revision = productionPreviewRevision(state.mockupVersions[0], state.units);
  state.units[0].garment.views[0].bodyScale = { widthRatio: .4, basis: 'confirmed-armpits', standardId: '00000000-0000-4000-8000-000000000090' };
  expect(productionPreviewCalibrationKey(state.units)).not.toBe(before);
  expect(productionPreviewRevision(state.mockupVersions[0], state.units)).toBe(revision);
});
