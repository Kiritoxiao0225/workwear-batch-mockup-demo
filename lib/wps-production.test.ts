import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { productionPlacementGeometry } from '@/lib/production-garment';
import { assertWpsProductionState } from '@/lib/server/wps-production-store';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { describe, expect, it } from 'vitest';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';

import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import {
  approveProductionVersion,
  attachProductionArtwork,
  completeVersionComposition,
  confirmProductionArtwork,
  confirmProductionPlan,
  emptyWpsProductionState,
  importTaskReviews,
  markVersionComposing,
  placeProductionArtwork,
  saveProductionTextVerification,
  returnProductionUnit,
  updateProductionPlan,
  upsertTaskReviews,
  WPS_COMPOSITOR_VERSION,
  type ArtworkValidation,
  type WpsProductionState,
} from '@/lib/wps-production';

const now = new Date('2026-09-03T00:00:00.000Z');

function validArtwork(sha: string): ArtworkValidation {
  return {
    valid: true,
    mimeType: 'image/png',
    width: 800,
    height: 600,
    byteLength: 1000,
    sha256: sha.padEnd(64, '0'),
    quality: artworkQualityFixture(sha.padEnd(64, '0')),
    transparentPixelRatio: 0.5,
    visiblePixelRatio: 0.5,
    checkedAt: now.toISOString(),
    ruleVersion: 'transparent-artwork-v1',
    issues: [],
  };
}

function approveArtwork(state: WpsProductionState, unitId: string, sha: string) {
  let next = confirmProductionPlan(state, unitId, '测试员', now);
  next = attachProductionArtwork(next, unitId, {
    url: `/uploads/logos/${unitId}.png`,
    name: `${unitId}.png`,
    validation: validArtwork(sha),
    service: 'auto',
    requestSummary: '测试制作，不调用外部服务',
  }, `attempt-${unitId}`, now);
  return confirmProductionArtwork(next, unitId, '测试员', now);
}

function twoSidedState() {
  const review = taskReviewFixture()[2];
  return importTaskReviews(emptyWpsProductionState(now), [review], now);
}

describe('text-only production', () => {
  it('saves, confirms and places text without requiring an image source', () => {
    const review = taskReviewFixture()[0];
    review.source.requirementText = '左胸:诺维特酒店保洁 后背: 字体: 颜色:';
    review.units = [{ ...review.units[0], logo: { materialId: null, url: null, name: '' }, textMode: 'replace', exactText: '诺维特酒店保洁', layoutNote: '', instruction: '左胸制作文字“诺维特酒店保洁”。', ambiguities: [] }];
    let state = importTaskReviews(emptyWpsProductionState(now), [review], now);
    const unit = state.units[0];
    expect(unit.route).toBe('deterministic');
    state = confirmProductionPlan(state, unit.id, '测试员', now);
    state = attachProductionArtwork(state, unit.id, { url: '/uploads/logos/text.png', name: 'text.png', validation: validArtwork('text'), service: 'deterministic', requestSummary: '程序文字排版' }, 'text-attempt', now);
    state = confirmProductionArtwork(state, unit.id, '测试员', now);
    expect(state.units[0].status).toBe('artworkApproved');
    assertWpsProductionState(state);
  });
});

describe('WPS production state machine', () => {
  it('changing the next cutout mode retains the approved current artwork and gates', () => {
    let state = twoSidedState();
    const unitId = state.units[0].id;
    state = approveArtwork(state, unitId, 'cutout-mode');
    const before = state.units[0];
    const next = updateProductionPlan(state, unitId, { cutoutMode: 'meitu' }, new Date(now.getTime() + 1000));
    expect(next.units[0].cutoutMode).toBe('meitu');
    expect(next.units[0].artwork).toEqual(before.artwork); expect(next.units[0].gateB).toEqual(before.gateB);
    expect(next.units[0].recipeFingerprint).toBe(before.recipeFingerprint);
    assertWpsProductionState(next);
  });
  it('updates an embedded instruction in the summary without changing source evidence or other units', () => {
    const state = twoSidedState();
    const [unit, other] = state.units;
    state.records[0].summary = `${unit.garmentLabel}：${unit.instruction}；${other.instruction}`;
    const instruction = '左胸使用图1的 Logo 图形，搭配文字“poppy手机数码”，Logo 改为绿色。';

    const updated = updateProductionPlan(state, unit.id, { instruction }, now);

    expect(updated.records[0].summary).toBe(`${unit.garmentLabel}：${instruction}；${other.instruction}`);
    expect(updated.records[0].source).toEqual(state.records[0].source);
    expect(updated.units[1]).toEqual(other);
    expect(state.records[0].summary).toContain(unit.instruction);
    assertWpsProductionState(updated);
  });

  it('saves first-draft automatic size with artwork and invalidates placement approval without overriding explicit dimensions', () => {
    let state = twoSidedState();
    const unitId = state.units[0].id;
    state = updateProductionPlan(state, unitId, { placement: { ...state.units[0].placement!, sizeMode: 'standard' } }, now);
    state = confirmProductionPlan(state, unitId, '测试员', now);
    const before = state.units[0];
    const input = { url: '/uploads/logos/auto.png', name: 'auto.png', validation: validArtwork('a'), service: 'auto' as const, requestSummary: '初次自动排版', automaticWidthCm: 8.4 };
    const next = attachProductionArtwork(state, unitId, input, 'auto-layout', now);
    expect(next.units[0].placement).toMatchObject({ widthCm: 8.4, sizeMode: 'widthCm', sizePolicy: 'body-55-v1' });
    expect(next.units[0].planFingerprint).not.toBe(before.planFingerprint);
    expect(next.units[0].recipeFingerprint).toBe(before.recipeFingerprint);
    expect(next.units[0].gateA).toBeNull();
    expect(next.units[0].gateB).toBeNull();
    expect(next.revision).toBe(state.revision + 1);
    assertWpsProductionState(next);
    expect(() => attachProductionArtwork(next, unitId, input, 'explicit', now)).toThrow('不得覆盖');
    expect(() => attachProductionArtwork(state, unitId, { ...input, automaticWidthCm: 55 }, 'oversized', now)).toThrow('超出允许范围');
  });

  it.each([
    { name: 'changed visible proportions inside an unchanged PNG canvas', previousBounds: { left: 100, top: 100, width: 200, height: 200 }, nextBounds: { left: 100, top: 100, width: 400, height: 200 }, nextWidth: 800, nextHeight: 600, invalidates: true },
    { name: 'replacement pixels and a larger canvas with the same visible proportions', previousBounds: { left: 100, top: 100, width: 200, height: 200 }, nextBounds: { left: 200, top: 200, width: 400, height: 400 }, nextWidth: 1600, nextHeight: 1200, invalidates: false },
    { name: 'a legacy artwork without stored content bounds', previousBounds: undefined, nextBounds: { left: 100, top: 100, width: 400, height: 400 }, nextWidth: 800, nextHeight: 600, invalidates: true },
  ])('rechecks placement only when the physical footprint changes: $name', ({ previousBounds, nextBounds, nextWidth, nextHeight, invalidates }) => {
    const review = taskReviewFixture()[0];
    const garment = garmentFixture();
    review.units[0].garment = garment;
    let state = importTaskReviews(emptyWpsProductionState(now), [review], now);
    const unitId = state.units[0].id;
    const validation = { ...validArtwork('a'), ...(previousBounds ? { contentBounds: previousBounds } : {}) };
    const placement = { ...state.units[0].placement!, sizeMode: 'widthCm' as const, widthCm: 8, manual: { centerX: .5, centerY: .5, width: .1 } };
    state = attachProductionArtwork(state, unitId, { url: '/uploads/logos/original.png', name: 'original.png', validation, service: 'auto', requestSummary: '已确认的原图案' }, 'original', now);
    state = confirmProductionArtwork(state, unitId, '测试员', now);
    state = placeProductionArtwork(state, unitId, placement, validation, '测试员', now);
    const previous = state.units[0];
    const nextValidation = { ...validArtwork('b'), width: nextWidth, height: nextHeight, contentBounds: nextBounds };
    const beforeGeometry = productionPlacementGeometry(garment, placement, (previousBounds ?? validation).width / (previousBounds ?? validation).height);
    const afterGeometry = productionPlacementGeometry(garment, placement, nextBounds.width / nextBounds.height);
    expect(afterGeometry.width).toBe(beforeGeometry.width);
    expect(afterGeometry.height !== beforeGeometry.height).toBe(invalidates);

    const attached = attachProductionArtwork(state, unitId, { url: '/uploads/logos/replacement.png', name: 'replacement.png', validation: nextValidation, service: 'manual-upload', requestSummary: '精修或上传替换图案' }, 'replacement', now);
    expect(attached.units[0].gateA).toEqual(invalidates ? null : previous.gateA);
    expect(attached.units[0].gateB).toBeNull();
    expect(attached.units[0].placement).toEqual(previous.placement);
    expect(attached.units[0].recipeFingerprint).toBe(previous.recipeFingerprint);
    const confirmed = confirmProductionArtwork(attached, unitId, '测试员', now);
    expect(confirmed.units[0].status).toBe(invalidates ? 'pendingPlanConfirmation' : 'artworkApproved');
    if (invalidates) expect(() => markVersionComposing(confirmed, confirmed.mockupVersions[0].id, now)).toThrow('不能合成');
    else expect(confirmed.mockupVersions[0].status).toBe('readyToCompose');
    assertWpsProductionState(confirmed);
  });

  it('confirms task-local placement after the logo, without creating a catalog standard', () => {
    const review = taskReviewFixture()[0];
    const garment = garmentFixture();
    garment.views.forEach(view => { view.standard = null; });
    review.units[0].garment = garment;
    let state = importTaskReviews(emptyWpsProductionState(now), [review], now);
    const unitId = state.units[0].id;
    const validation = validArtwork('a');
    const placement = { ...state.units[0].placement!, manual: { centerX: .64, centerY: .34, width: .15 } };
    expect(() => placeProductionArtwork(state, unitId, placement, validation, '测试员', now)).toThrow('确认 Logo');
    state = attachProductionArtwork(state, unitId, { url: '/uploads/logos/test.png', name: 'test.png', validation, service: 'auto', requestSummary: '本地测试' }, 'manual-test', now);
    state = confirmProductionArtwork(state, unitId, '测试员', now);
    expect(state.units[0].gateA).toBeNull();
    const positioned = placeProductionArtwork(state, unitId, placement, validation, '测试员', now);
    expect(positioned.revision).toBe(state.revision + 1);
    expect(positioned.units[0].gateA).not.toBeNull();
    expect(positioned.units[0].gateB).toEqual(state.units[0].gateB);
    expect(positioned.units[0].garment).toEqual(garment);
    expect(positioned.mockupVersions[0].status).toBe('readyToCompose');
    assertWpsProductionState(positioned);
    const resized = updateProductionPlan(positioned, unitId, { placement: { ...placement, sizePolicy: 'body-55-v1', sizeMode: 'heightCm', heightCm: 6 } }, now);
    expect(resized.units[0].gateA).toBeNull();
    expect(resized.units[0].gateB).toEqual(positioned.units[0].gateB);
    expect(resized.units[0].artwork).toEqual(positioned.units[0].artwork);
    assertWpsProductionState(resized);
    expect(() => placeProductionArtwork(state, unitId, placement, validArtwork('b'), '测试员', now)).toThrow('文件已变化');
    expect(() => placeProductionArtwork(state, unitId, { ...placement, manual: { centerX: .99, centerY: .99, width: .5 } }, validation, '测试员', now)).toThrow('超出');
  });

  it('binds persisted OCR to the current artwork and never replaces human confirmation', () => {
    let state = twoSidedState();
    const unitId = state.units[0].id;
    const validation = validArtwork('a');
    state = attachProductionArtwork(state, unitId, { url: '/uploads/logos/ocr.png', name: 'ocr.png', validation, service: 'auto', requestSummary: '本地测试' }, 'ocr-test', now);
    const result = { expectedText: 'ABC', recognizedText: 'ABC', normalizedExpectedText: 'ABC', normalizedRecognizedText: 'ABC', minimumScore: .95, exactText: true, passed: true, reason: 'passed' as const, detectedLines: 1, durationMs: 500, contrastBackground: 'white' as const };
    state = saveProductionTextVerification(state, unitId, validation.sha256, result, now);
    expect(state.units[0].artwork?.textVerification).toEqual(result);
    expect(state.units[0].gateB).toBeNull();
    assertWpsProductionState(state);
    expect(() => saveProductionTextVerification(state, unitId, 'stale', result, now)).toThrow('图案已变化');
    expect(() => saveProductionTextVerification(state, unitId, validation.sha256, { ...result, minimumScore: NaN }, now)).toThrow();
    state = attachProductionArtwork(state, unitId, { url: '/uploads/logos/replacement.png', name: 'replacement.png', validation: validArtwork('b'), service: 'manual-upload', requestSummary: '换图' }, 'replacement', now);
    expect(state.units[0].artwork?.textVerification).toBeUndefined();
  });
  it('aggregates front and back units into one 2208 customer mockup version', () => {
    const state = twoSidedState();
    expect(state.units).toHaveLength(2);
    expect(state.units.map((unit) => unit.placement?.key)).toEqual(['frontCenter', 'back']);
    expect(state.units.every((unit) => unit.productCode === '2208')).toBe(true);
    expect(state.mockupVersions).toHaveLength(1);
    expect(state.mockupVersions[0].unitIds).toEqual(['snapshot-03-u1', 'snapshot-03-u2']);
  });

  it('keeps reference typography/layout on the shared automatic artwork pipeline', () => {
    const review = taskReviewFixture()[2];
    review.units[1] = {
      ...review.units[1],
      layoutNote: '字体、字形、版式和层级均参考图2',
    };
    const state = importTaskReviews(emptyWpsProductionState(now), [review], now);
    expect(state.units[1].route).toBe('auto');
    expect(state.units[1].routeEvidence).toContain('自动判断');
  });

  it('repairs missing reference bindings during import and records ambiguous purpose before artwork production', () => {
    const review = taskReviewFixture()[2];
    review.source.requirementText = '正面 图一\n后脖 图一前三排 按照图二做';
    Object.assign(review.units[1], { referenceMaterialIds: [], sourceScope: 'subject', layoutNote: '', instruction: '后脖使用图一，按照图二样式制作' });
    const state = importTaskReviews(emptyWpsProductionState(now), [review], now);
    const back = state.units[1];
    expect(back.referenceMaterialIds).toEqual([review.source.materials[1].id]);
    expect(back.sourceScope).toBe('custom');
    expect(back.instruction).toContain('图1前三排');
    expect(back.status).toBe('blocked');
    expect(back.ambiguities.join('；')).toContain('用途尚未明确');
    const resolved = updateProductionPlan(state, back.id, { layoutNote: '图2只参考后领小图案的排版；内容取图1前三排。' }, now).units[1];
    expect(resolved.route).toBe('auto');
    expect(resolved.ambiguities).toEqual([]);
  });

  it('rejects incomplete plan edits before invalidating saved artwork or gates', () => {
    let state = twoSidedState();
    const backId = state.units[1].id;
    state = approveArtwork(state, backId, 'saved-back');
    const frozen = JSON.stringify(state);
    expect(() => updateProductionPlan(state, backId, { referenceMaterialIds: [] }, now)).toThrow('未绑定');
    expect(() => updateProductionPlan(state, backId, { sourceScope: 'subject' }, now)).toThrow('按描述取用');
    expect(() => updateProductionPlan(state, backId, { referenceMaterialIds: ['nonexistent-material'] }, now)).toThrow('参考素材已不存在');
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('keeps an existing edited record intact when reanalysis renumbers or omits units', () => {
    let state = twoSidedState();
    state = approveArtwork(state, state.units[0].id, 'saved-front');
    const originalUnits = structuredClone(state.units);
    const analysis = taskReviewFixture()[2];
    analysis.units = [{ ...analysis.units[0], id: 'new-model-unit', instruction: '使用图1的另一部分' }];
    const next = upsertTaskReviews(state, [analysis], now);
    expect(next.units).toEqual(originalUnits);
    expect(next.records).toEqual(state.records);
    expect(next.mockupVersions).toEqual(state.mockupVersions);
    expect(next.units[0].gateB).not.toBeNull();
  });

  it('leaves other records and versions unchanged when editing one plan', () => {
    const reviews = taskReviewFixture();
    const state = importTaskReviews(emptyWpsProductionState(now), [reviews[0], reviews[2]], now);
    const untouched = state.mockupVersions.find(version => version.sourceRecordId === reviews[0].source.recordId)!;
    const next = updateProductionPlan(state, 'snapshot-03-u2', { layoutNote: '图2只参考后背图案的排版' }, new Date('2026-09-08T00:00:00Z'));
    expect(next.mockupVersions.find(version => version.id === untouched.id)).toEqual(untouched);
    expect(next.units[0]).toEqual(state.units[0]);
  });

  it('does not allow Gate A confirmation while placement is ambiguous', () => {
    const review = taskReviewFixture()[0];
    review.units[0] = { ...review.units[0], placement: null, ambiguities: ['正面是左胸还是正前面'] };
    const state = importTaskReviews(emptyWpsProductionState(now), [review], now);
    expect(() => confirmProductionPlan(state, review.units[0].id, '测试员', now)).toThrow('门 A 不能确认');
  });

  it('retains approved artwork for placement-only edits but invalidates Gate A and final output', () => {
    let state = twoSidedState();
    state = approveArtwork(state, 'snapshot-03-u1', 'a');
    const unit = state.units.find((candidate) => candidate.id === 'snapshot-03-u1')!;
    state = updateProductionPlan(state, unit.id, {
      placement: { ...unit.placement!, offsetX: 2 },
    }, now);
    const changed = state.units.find((candidate) => candidate.id === unit.id)!;
    expect(changed.gateA).toBeNull();
    expect(changed.artwork).not.toBeNull();
    expect(changed.gateB).not.toBeNull();
    expect(changed.status).toBe('pendingPlanConfirmation');
    expect(state.mockupVersions[0].output).toBeNull();
  });

  it('invalidates artwork and Gate B when the artwork recipe changes', () => {
    let state = twoSidedState();
    state = approveArtwork(state, 'snapshot-03-u1', 'b');
    state = updateProductionPlan(state, 'snapshot-03-u1', { exactText: '新的文字' }, now);
    const changed = state.units.find((candidate) => candidate.id === 'snapshot-03-u1')!;
    expect(changed.gateA).toBeNull();
    expect(changed.artwork).toBeNull();
    expect(changed.gateB).toBeNull();
  });

  it('preserves artwork and audit attempts when re-analysis only changes placement', () => {
    let state = twoSidedState();
    state = approveArtwork(state, 'snapshot-03-u1', 'b2');
    const reviews = taskReviewFixture();
    reviews[2].units[0] = { ...reviews[2].units[0], placement: 'leftChest' };
    state = importTaskReviews(state, [reviews[2]], now);
    const changed = state.units.find((candidate) => candidate.id === 'snapshot-03-u1')!;
    expect(changed.gateA).toBeNull();
    expect(changed.artwork).not.toBeNull();
    expect(changed.gateB).not.toBeNull();
    expect(changed.attempts).toHaveLength(1);
  });

  it('becomes composable only after every front/back unit passes Gate B', () => {
    let state = twoSidedState();
    state = approveArtwork(state, 'snapshot-03-u1', 'c');
    expect(state.mockupVersions[0].status).toBe('waitingArtwork');
    state = approveArtwork(state, 'snapshot-03-u2', 'd');
    expect(state.mockupVersions[0].status).toBe('readyToCompose');
    state = markVersionComposing(state, state.mockupVersions[0].id, now);
    expect(state.mockupVersions[0].status).toBe('composing');
  });

  it('rejects stale composition and returns one failed placement without duplicating delivery', () => {
    let state = twoSidedState();
    state = approveArtwork(state, 'snapshot-03-u1', 'e');
    state = approveArtwork(state, 'snapshot-03-u2', 'f');
    const versionId = state.mockupVersions[0].id;
    state = markVersionComposing(state, versionId, now);
    const composeFingerprint = state.mockupVersions[0].composeFingerprint!;
    const staleOutput = {
      url: '/uploads/mockups/test.png',
      name: 'test.png',
      sha256: '9'.repeat(64),
      width: 4462,
      height: 2556,
      byteLength: 2000,
      composeFingerprint,
      compositorVersion: WPS_COMPOSITOR_VERSION as typeof WPS_COMPOSITOR_VERSION,
      createdAt: now.toISOString(),
    };
    const changed = updateProductionPlan(state, 'snapshot-03-u1', {
      placement: { ...state.units[0].placement!, offsetY: 3 },
    }, now);
    expect(() => completeVersionComposition(changed, versionId, staleOutput, now)).toThrow('旧结果不能覆盖');

    state = completeVersionComposition(state, versionId, staleOutput, now);
    const unframed = structuredClone(state);
    unframed.mockupVersions[0].output!.compositorVersion = 'sharp-catalog-compositor-v2';
    assertWpsProductionState(unframed);
    expect(() => approveProductionVersion(unframed, versionId, '测试员', now)).toThrow('请先更新为带框客户图');
    state = approveProductionVersion(state, versionId, '测试员', now);
    expect(state.mockupVersions[0].status).toBe('approved');
    state = returnProductionUnit(state, versionId, 'snapshot-03-u1', '正面位置需上移', now);
    expect(state.mockupVersions).toHaveLength(1);
    expect(state.mockupVersions[0].status).toBe('waitingArtwork');
    expect(state.mockupVersions[0].output).toBeNull();
    expect(state.units.find((unit) => unit.id === 'snapshot-03-u1')?.returnReason).toBe('正面位置需上移');
    expect(state.units.find((unit) => unit.id === 'snapshot-03-u2')?.status).toBe('artworkApproved');
  });
});


it('prepares and confirms both artworks before calibration, then composes one real garment only after both positions pass', () => {
  const review = taskReviewFixture()[2];
  const garment = garmentFixture();
  garment.views.forEach(view => { view.standard = null; });
  review.units = review.units.map(unit => ({ ...unit, garment }));
  let state = importTaskReviews(emptyWpsProductionState(now), [review], now);
  for (const unit of state.units) {
    state = attachProductionArtwork(state, unit.id, { url: `/uploads/logos/${unit.id}.png`, name: 'logo.png', validation: validArtwork(unit.id), service: 'auto', requestSummary: 'test artwork' }, `attempt-${unit.id}`, now);
    state = confirmProductionArtwork(state, unit.id, '测试员', now);
  }
  expect(state.units.every(unit => unit.gateB && !unit.gateA)).toBe(true);
  expect(state.mockupVersions).toHaveLength(1);
  expect(state.mockupVersions[0].status).toBe('waitingArtwork');
  expect(() => markVersionComposing(state, state.mockupVersions[0].id, now)).toThrow();
  expect(() => confirmProductionPlan(state, state.units[0].id, '测试员', now)).toThrow('尚未校准');
  for (const unit of state.units) {
    state = updateProductionPlan(state, unit.id, { garment: garmentFixture() }, now);
    state = confirmProductionPlan(state, unit.id, '测试员', now);
  }
  expect(state.units.every(unit => unit.gateA && unit.gateB)).toBe(true);
  expect(state.mockupVersions).toHaveLength(1);
  expect(state.mockupVersions[0].status).toBe('readyToCompose');
});


it('keeps garment uncertainty at Gate A while allowing independently specified logo work', () => {
  const review = taskReviewFixture()[0];
  review.units[0].ambiguities = ['未明确说明货号对应冲锋衣或POLO衫'];
  const state = importTaskReviews(emptyWpsProductionState(now), [review], now);
  expect(state.units[0].route).toBe('auto');
  expect(state.units[0].status).toBe('pendingArtwork');
  expect(() => confirmProductionPlan(state, state.units[0].id, '测试员', now)).toThrow('货号');
  expect(() => attachProductionArtwork(state, state.units[0].id, { url: '/uploads/logos/test.png', name: 'test.png', validation: validArtwork('z'), service: 'auto', requestSummary: 'test' }, 'test-attempt', now)).not.toThrow();
});

it('allows saving and confirming an artwork whose legacy route was blocked only by an AI doubt', () => {
  const state = twoSidedState();
  const unit = state.units[0];
  unit.route = 'blocked'; unit.status = 'blocked'; unit.ambiguities = ['图案可能为白色，纯白底下无法分离，请确认颜色。'];
  const original = structuredClone(unit);
  const saved = attachProductionArtwork(state, unit.id, { url: '/uploads/logos/ai-note.png', name: 'ai-note.png', validation: validArtwork('a'), service: 'auto', requestSummary: '按已保存的要求制作' }, 'ai-note', now);
  expect(saved.units[0].artwork).not.toBeNull(); expect(saved.units[0].status).toBe('pendingArtworkConfirmation');
  expect(saved.units[0].recipeFingerprint).toBe(original.recipeFingerprint);
  expect(saved.units[0].ambiguities).toEqual(original.ambiguities);
  expect(() => confirmProductionArtwork(saved, unit.id, '测试员', now)).not.toThrow();
  expect(state.units[0]).toEqual(original);
});


it('persists editable artwork and actual prompt provenance through reload; editing reopens Gate B', () => {
  let state = twoSidedState();
  const id = state.units[0].id;
  const draft = createLegacyArtworkDraft('/uploads/logos/test.png');
  state = attachProductionArtwork(state, id, { url: '/uploads/logos/test.png', name: 'test.png', validation: validArtwork('1'), draft, service: 'auto', requestSummary: '模型生成：测试模型', prompt: 'exact prompt', promptHash: 'hash', inputImageUrls: ['/test-reference.png'] }, 'draft-attempt', now);
  state = confirmProductionArtwork(state, id, '测试员', now);
  const restored: unknown = JSON.parse(JSON.stringify(state));
  assertWpsProductionState(restored);
  expect(restored.units[0].artwork?.draft).toEqual(draft);
  expect(restored.units[0].attempts[0]).toMatchObject({ prompt: 'exact prompt', promptHash: 'hash', inputImageUrls: ['/test-reference.png'], actualCostCny: null });
  const changedDraft = { ...draft, graphic: { ...draft.graphic, x: draft.graphic.x + 10 } };
  state = attachProductionArtwork(restored, id, { url: '/uploads/logos/edited.png', name: 'edited.png', validation: validArtwork('2'), draft: changedDraft, service: 'manual-upload', requestSummary: '人工调整' }, 'edit-attempt', now);
  expect(state.units[0].gateB).toBeNull();
  expect(state.units[0].artwork?.draft).toEqual(changedDraft);
  expect(state.mockupVersions[0].status).toBe('waitingArtwork');
});

describe('operator method selection', () => {
  it('persists the chosen method, invalidates approvals, and retains the previous artwork for comparison only', () => {
    const review = taskReviewFixture()[0];
    review.units[0].garment = garmentFixture();
    let state = importTaskReviews(emptyWpsProductionState(now), [review], now);
    const id = state.units[0].id;
    state = attachProductionArtwork(state, id, { url: '/uploads/logos/previous.png', name: 'previous.png', validation: validArtwork('method'), service: 'manual-upload', requestSummary: 'test' }, 'method-attempt', now);
    state = confirmProductionArtwork(state, id, '测试员', now);
    const before = state.units[0], records = structuredClone(state.records);
    state = updateProductionPlan(state, id, { artworkMethod: 'redraw' }, now);
    expect(state.units[0]).toMatchObject({ artworkMethod: 'redraw', route: 'auto', artwork: null, gateA: null, gateB: null, previousArtwork: before.artwork });
    expect(state.units[0].recipeFingerprint).not.toBe(before.recipeFingerprint);
    expect(state.records).toEqual(records);
    expect(() => confirmProductionArtwork(state, id, '测试员', now)).toThrow('没有可确认');
    assertWpsProductionState(state);
  });
});


describe('saved generation prompt', () => {
  it('imports the body and preserves completed artwork until the user saves a changed prompt', () => {
    const review = taskReviewFixture()[0];
    review.units[0].generationPrompt = '使用图1制作图案，纯白背景。';
    let state = importTaskReviews(emptyWpsProductionState(), [review, taskReviewFixture()[2]], now);
    const id = review.units[0].id;
    expect(state.units.find(unit => unit.id === id)?.generationPrompt).toBe(review.units[0].generationPrompt);
    state = attachProductionArtwork(state, id, { url: '/uploads/logos/prompt-test.png', name: 'test', validation: validArtwork('a'), service: 'auto', requestSummary: 'test' }, 'prompt-attempt', now);
    const original = state.units.find(unit => unit.id === id)!;
    const unchanged = updateProductionPlan(state, id, { generationPrompt: original.generationPrompt });
    expect(unchanged.units.find(unit => unit.id === id)?.artwork).toEqual(original.artwork);
    const changed = updateProductionPlan(state, id, { generationPrompt: '使用图1制作图案，新增文字“研”，纯白背景。' });
    const next = changed.units.find(unit => unit.id === id)!;
    expect(next.recipeFingerprint).not.toBe(original.recipeFingerprint);
    expect(next.artwork).toBeNull();
    expect(next.previousArtwork).toEqual(original.artwork);
    expect(changed.units.filter(unit => unit.id !== id)).toEqual(state.units.filter(unit => unit.id !== id));
    // 候选修复统一了阻塞文案：同一语义（引用未绑定图号必须在保存前拦截），新文案来自 compileArtworkRequirements 的 PROMPT_IMAGE_MISSING。
    expect(() => updateProductionPlan(state, id, { generationPrompt: '参考图99制作' })).toThrow('制作要求引用图99，但本次没有传入该图');
  });
  it.each(['auto', 'preserve', 'redraw', 'compose', 'generate'] as const)('saving a prompt leaves the selected %s method unchanged', artworkMethod => {
    const review = taskReviewFixture()[0];
    let state = importTaskReviews(emptyWpsProductionState(), [review], now);
    state = updateProductionPlan(state, review.units[0].id, { artworkMethod });
    const original = state.units[0];
    const updated = updateProductionPlan(state, original.id, { generationPrompt: '保留图1原设计，纯白背景。' }).units[0];
    expect(updated.artworkMethod).toBe(artworkMethod);
    expect(updated.route).toBe(original.route);
  });
  it('invalidates the prompt when a legacy content edit changes its source contract', () => {
    const review = taskReviewFixture()[0];
    review.units[0].generationPrompt = '使用图1制作图案，纯白背景。';
    const state = importTaskReviews(emptyWpsProductionState(), [review], now);
    const next = updateProductionPlan(state, review.units[0].id, { exactText: '新内容' });
    expect(next.units[0].generationPrompt).toBeUndefined();
  });
});
