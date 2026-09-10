import { describe, expect, it } from 'vitest';
import { artworkAcceptanceIssues, artworkQualityAdvice, retainArtworkQuality } from '@/lib/artwork-acceptance';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { attachProductionArtwork, confirmProductionArtwork, emptyWpsProductionState, importTaskReviews, saveProductionArtworkQuality, type ArtworkValidation } from '@/lib/wps-production';

const validation: ArtworkValidation = { valid: true, width: 1000, height: 800, mimeType: 'image/png', byteLength: 1000, sha256: 'a'.repeat(64), transparentPixelRatio: .5, visiblePixelRatio: .5, checkedAt: '2026-09-07T00:00:00Z', ruleVersion: 'transparent-artwork-v1', issues: [] };
function stateWithArtwork(value: ArtworkValidation) {
  const state = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[0]]);
  return attachProductionArtwork(state, state.units[0].id, { url: '/uploads/logos/test.png', name: 'test.png', validation: value, service: 'auto', requestSummary: '测试验收' }, 'test-attempt');
}
describe('final artwork acceptance', () => {
  it.each([
    undefined, artworkQualityFixture(validation.sha256, { score: 79.99 }),
    artworkQualityFixture(validation.sha256, { requiredScale: 1.2501 }),
    artworkQualityFixture('other-file'), artworkQualityFixture(validation.sha256, { protocol: 'legacy-source-native' }),
    artworkQualityFixture(validation.sha256, { score: 100, protocol: 'foreground-white-1000-v1' }),
  ])('allows human confirmation regardless of optional scores', quality => {
    const state = stateWithArtwork({ ...validation, quality });
    expect(confirmProductionArtwork(state, state.units[0].id, '测试员').units[0].gateB).not.toBeNull();
    expect(state.units[0].artwork).not.toBeNull();
  });
  it('identifies obsolete scores separately from a current pixel-size failure', () => {
    const old = { ...validation, quality: artworkQualityFixture(validation.sha256, { score: 2.56, protocol: 'foreground-white-1000-v1' }), qualityIssues: ['主体清晰度 2.56 未达标'] };
    expect(artworkQualityAdvice(old)).toEqual(['旧检测曾将模糊度当作清晰度，请重新检测画质；无需重新制作图案']);
    const insufficient = { ...validation, quality: artworkQualityFixture(validation.sha256, { score: 97.44, rawBlur: 2.56, requiredScale: 1.96 }) };
    expect(artworkQualityAdvice(insufficient)).toEqual(['有效像素不足：放大到 1000px 需 1.96 倍，超过 1.25 倍']);
  });
  it('does not let sharp composition text hide a poor logo component or an API failure', () => {
    const passing = { ...validation, quality: artworkQualityFixture(validation.sha256, { score: 80, requiredScale: 1.25 }) };
    expect(artworkAcceptanceIssues(passing)).toEqual([]);
    expect(artworkAcceptanceIssues({ ...passing, qualityIssues: ['主体未达标'] })).toEqual([]);
    expect(artworkAcceptanceIssues({ ...passing, contentIssues: ['重绘未完成'] })).toEqual(['重绘未完成']);
    expect(artworkAcceptanceIssues({ ...passing, qualityError: '检测未完成' })).toEqual([]);
  });
  it('preserves human confirmation when optional quality fails and refuses a different file score', () => {
    let state = stateWithArtwork({ ...validation, quality: artworkQualityFixture(validation.sha256) });
    const id = state.units[0].id;
    state = confirmProductionArtwork(state, id, '测试员');
    expect(state.units[0].gateB).not.toBeNull();
    const failed = { ...validation, quality: artworkQualityFixture(validation.sha256, { score: 60 }) };
    expect(saveProductionArtworkQuality(state, id, failed).units[0].gateB).not.toBeNull();
    expect(() => saveProductionArtworkQuality(state, id, { ...failed, sha256: 'changed' })).toThrow('图案已变化');
  });
  it('retains quality across OCR and placement checks only for the same SHA', () => {
    const previous = { ...validation, quality: artworkQualityFixture(validation.sha256), qualityIssues: ['保留问题'] };
    expect(retainArtworkQuality(previous, validation).quality).toEqual(previous.quality);
    expect(retainArtworkQuality(previous, { ...validation, sha256: 'changed' }).quality).toBeUndefined();
  });
  it('shows content reminders without blocking human confirmation or carrying them to a different image', () => {
    const advisory = { ...validation, contentWarnings: ['原图细节看不清，可能缺少一处细笔画'] };
    expect(artworkQualityAdvice(advisory)).toContain(advisory.contentWarnings[0]);
    expect(artworkAcceptanceIssues(advisory)).toEqual([]);
    const state = stateWithArtwork(advisory);
    expect(confirmProductionArtwork(state, state.units[0].id, '测试员').units[0].gateB).not.toBeNull();
    expect(retainArtworkQuality(advisory, validation).contentWarnings).toEqual(advisory.contentWarnings);
    expect(retainArtworkQuality(advisory, { ...validation, sha256: 'different' }).contentWarnings).toBeUndefined();
  });
});
