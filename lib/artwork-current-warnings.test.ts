import { describe, expect, it } from 'vitest';
import { taskBFixture } from './testing/task-b-fixture';
import { currentArtworkWarnings } from './artwork-current-warnings';
import { applyFinalArtworkReview, buildArtworkReview, manualArtworkReview } from './artwork-review-ledger';
import { artworkAcceptanceIssues } from './artwork-acceptance';
import type { ArtworkEditVerification } from './artwork-model-edits';

export function warningFixture(checks: ArtworkEditVerification['checks']) {
  const fixture = taskBFixture(), { unit } = fixture;
  const review = buildArtworkReview(unit, unit.artwork!.validation);
  unit.artwork!.validation.review = applyFinalArtworkReview(review, { version: 'artwork-edit-check-v1', sourceSha256: 'a'.repeat(64),
    outputSha256: unit.artwork!.validation.sha256, model: 'offline-fixture-not-a-model-call', checks });
  return fixture;
}
describe('B5 current unresolved quality warnings, not historical failures', () => {
  it('exposes missing Logo text, shape and colour while retaining the existing non-blocking acceptance contract', () => {
    const { unit } = warningFixture(['text', 'structure', 'color'].map(category => ({ category: category as 'text' | 'structure' | 'color',
      status: 'failed' as const, requirement: '保留整块Logo并改白', evidence: '整块Logo丢失' })));
    const before = structuredClone(unit);
    expect(currentArtworkWarnings(unit).filter(warning => warning.kind === 'difference')).toHaveLength(3);
    expect(currentArtworkWarnings(unit).some(warning => warning.message.includes('整块Logo丢失'))).toBe(true);
    expect(artworkAcceptanceIssues(unit.artwork!.validation)).toEqual([]);
    expect(unit).toEqual(before);
  });
  it.each(['新增描边是否符合要求需确认', 'SAIMAI 注册标记可能缺失'])('keeps %s visibly uncertain, never a pass or hard block', evidence => {
    const { unit } = warningFixture([{ category: 'structure', status: 'uncertain', requirement: '保留标志', evidence }]);
    expect(currentArtworkWarnings(unit)).toContainEqual({ kind: 'uncertain', label: '图形', message: evidence });
    expect(artworkAcceptanceIssues(unit.artwork!.validation)).toEqual([]);
  });
  it('distinguishes check-service failure, pending human review and actual observed differences', () => {
    const { unit } = warningFixture([{ category: 'text', status: 'uncertain', requirement: '文字一致', evidence: '自动核对未完成：服务超时' }]);
    expect(currentArtworkWarnings(unit).some(warning => warning.kind === 'unavailable')).toBe(true);
    expect(currentArtworkWarnings(unit).some(warning => warning.kind === 'pending')).toBe(true);
    expect(currentArtworkWarnings(unit).some(warning => warning.kind === 'difference')).toBe(false);
  });
  it('removes accepted differences and confirmed items from the main warnings without deleting history', () => {
    const { unit } = warningFixture([{ category: 'color', status: 'failed', requirement: '白色', evidence: '蓝色' }]);
    const review = unit.artwork!.validation.review!;
    unit.artwork!.validation.review = manualArtworkReview(review, review.items.map(item => item.id), 'accepted', '客户核对员', '对照当前原图后接受差异');
    const before = structuredClone(unit);
    expect(currentArtworkWarnings(unit)).toEqual([]);
    expect(currentArtworkWarnings(unit, true)).toEqual([]);
    expect(unit.artwork!.validation.review.history.at(-1)!.items.find(item => item.id === 'color')!.status).toBe('failed');
    expect(unit).toEqual(before);
  });
  it.each(['sha', 'requirement'] as const)('does not repeat the old failure after a %s change', field => {
    const { unit } = warningFixture([{ category: 'structure', status: 'failed', requirement: 'Logo完整', evidence: 'OLD_LOGO_FAILURE' }]);
    if (field === 'sha') unit.artwork!.validation.sha256 = 'c'.repeat(64);
    else unit.instruction += ' 新版要求';
    const before = structuredClone(unit), warnings = currentArtworkWarnings(unit);
    expect(warnings.some(warning => warning.kind === 'pending')).toBe(true);
    expect(JSON.stringify(warnings)).not.toContain('OLD_LOGO_FAILURE');
    expect(unit).toEqual(before);
  });
  it('does not adopt historical check reports or invent review records for legacy drafts on read', () => {
    const { unit } = taskBFixture(), before = structuredClone(unit);
    expect(currentArtworkWarnings(unit)[0].kind).toBe('pending');
    expect(unit).toEqual(before);
    unit.artwork = null;
    expect(currentArtworkWarnings(unit)).toEqual([]);
  });
});
