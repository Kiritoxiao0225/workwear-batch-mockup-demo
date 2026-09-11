import { describe, expect, it } from 'vitest';
import { buildArtworkReview, currentArtworkReview, applyFinalArtworkReview, manualArtworkReview, reviewForAttachment } from './artwork-review-ledger';
import { createStructuredArtworkDraft, createLegacyArtworkDraft, type ArtworkGraphicLayer } from './artwork-editor';
import { taskReviewFixture } from './testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews, type ArtworkValidation, type ProductionArtwork } from './wps-production';
import { artworkCorrectionIssues } from './artwork-correction';
import { artworkAcceptanceIssues } from './artwork-acceptance';

function fixture() {
  const unit = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[0]]).units[0];
  const draft = createLegacyArtworkDraft('/uploads/logos/test.png');
  const validation = { sha256: 'a'.repeat(64), checkedAt: '2026-09-11T00:00:00Z', valid: true, issues: [] } as unknown as ArtworkValidation;
  const review = buildArtworkReview(unit, validation, draft);
  const complete = manualArtworkReview(review, review.items.map(i => i.id), 'confirmed', '测试员', '对照原图和上衣逐项核实');
  const artwork: ProductionArtwork = { url: '/uploads/logos/test.png', name: 'test', validation: { ...validation, review: complete }, draft, recipeFingerprint: unit.recipeFingerprint, createdAt: validation.checkedAt };
  return { unit: { ...unit, artwork }, artwork, draft, validation, complete };
}
describe('version-bound artwork review', () => {
  it('does not adopt or mutate legacy records on read', () => {
    const { unit } = fixture(); delete unit.artwork.validation.review;
    expect(currentArtworkReview(unit)).toBeNull(); expect(unit.artwork.validation.review).toBeUndefined();
  });
  it('reuses exact results across repeated reads and JSON key ordering', () => {
    const { unit, complete } = fixture();
    expect(currentArtworkReview(unit)).toEqual(complete);
    unit.artwork.draft!.graphic = Object.fromEntries(Object.entries(unit.artwork.draft!.graphic).reverse()) as ArtworkGraphicLayer;
    expect(currentArtworkReview(unit)).toEqual(complete);
  });
  it('invalidates only color for an editable recolor; saving does not mark fixed', () => {
    const { unit, artwork, draft, validation } = fixture();
    const changed = structuredClone(draft); changed.graphic.recolor = { mode: 'solid', color: '#ffffff' };
    const next = buildArtworkReview(unit, { ...validation, sha256: 'b'.repeat(64) }, changed, artwork);
    expect(next.items.filter(i => i.status === 'pending').map(i => i.id)).toEqual(['color']);
    expect(next.history).toHaveLength(2); expect(artwork.validation.review!.items.every(i => i.status === 'confirmed')).toBe(true);
  });
  it('text edits invalidate text, layout and size while retaining unrelated color checks', () => {
    const { unit, validation } = fixture();
    const draft = createStructuredArtworkDraft({ graphicSourceUrl: '/uploads/logos/test.png', graphicWidth: 800, graphicHeight: 600,
      exactText: '康悦', instruction: '', layoutNote: '', enhancement: 'none', backgroundRemoval: 'none' });
    const review = buildArtworkReview(unit, validation, draft);
    const complete = manualArtworkReview(review, review.items.map(i => i.id), 'confirmed', '测试员', '逐项对照');
    const previous = { ...unit.artwork, draft, validation: { ...validation, review: complete } };
    const changed = structuredClone(draft); changed.text!.value = '康乐';
    const next = buildArtworkReview(unit, { ...validation, sha256: 'b'.repeat(64) }, changed, previous);
    expect(next.items.filter(i => i.status === 'pending').map(i => i.id)).toEqual(['text', 'layout', 'size']);
  });
  it('moving on garment preserves all content checks and leaves size/position pending', () => {
    const { unit, complete } = fixture();
    unit.placement = { ...unit.placement!, offsetY: 3 };
    const next = currentArtworkReview(unit)!;
    expect(next.items.filter(i => i.status === 'pending').map(i => i.id)).toEqual(['size', 'position']);
    expect(next.items.find(i => i.id === 'color')).toEqual(complete.items.find(i => i.id === 'color'));
  });
  it('replacing flattened source requires new content checks even with the same report', () => {
    const { unit, artwork, draft, validation } = fixture();
    const changed = structuredClone(draft); changed.graphic.sourceUrl = '/uploads/logos/new.png';
    const next = buildArtworkReview(unit, { ...validation, sha256: 'b'.repeat(64) }, changed, artwork);
    expect(next.items.filter(i => i.status === 'pending')).toHaveLength(6);
  });
  it('changed requirement invalidates checks even when pixels stay identical', () => {
    const { unit } = fixture(); unit.instruction += ' 改为红色';
    expect(currentArtworkReview(unit)!.items.every(i => i.status === 'pending')).toBe(true);
  });
  it('only matching final image checks establish pass/fail/uncertain', () => {
    const { complete } = fixture();
    const verification = { version: 'artwork-edit-check-v1' as const, sourceSha256: 'source', outputSha256: complete.sha256, model: 'test', checks: [
      { category: 'color' as const, requirement: '白色', status: 'failed' as const, evidence: '实际深蓝色', correction: '恢复白色，保留橙色' },
      { category: 'text' as const, requirement: '弧形字', status: 'uncertain' as const, evidence: '无法辨认第二字' },
    ] };
    expect(() => applyFinalArtworkReview(complete, { ...verification, outputSha256: 'old' })).toThrow();
    const next = applyFinalArtworkReview(complete, verification);
    expect(next.items.find(i => i.id === 'color')!.status).toBe('failed');
    expect(next.items.find(i => i.id === 'text')!.status).toBe('uncertain');
    expect(artworkCorrectionIssues(undefined, next).map(i => i.action)).toContain('恢复白色，保留橙色');
    const accepted = manualArtworkReview(next, ['color'], 'accepted', '操作员', '客户同意保留深蓝');
    expect(artworkCorrectionIssues(undefined, accepted).map(i => i.id)).not.toContain('review-color');
    expect(accepted.history.at(-1)!.items.find(i => i.id === 'color')!.status).toBe('failed');
    expect(artworkAcceptanceIssues({ review: next, valid: true, issues: [] } as unknown as ArtworkValidation)).toEqual([]);
  });
  it('requires an explicit actor, note, and valid selection for human decisions', () => {
    const { complete } = fixture();
    expect(() => manualArtworkReview(complete, [], 'accepted', '测试', 'ok')).toThrow();
    expect(() => manualArtworkReview(complete, ['color'], 'accepted', '', 'ok')).toThrow();
    expect(() => manualArtworkReview(complete, ['color'], 'accepted', '测试', '')).toThrow();
  });
  it('retains review history when changed requirements move the old image into previousArtwork', () => {
    const { unit, artwork, validation, draft } = fixture();
    const changedUnit = { ...unit, instruction: '新要求：白色文字', artwork: null, previousArtwork: artwork };
    const review = reviewForAttachment(changedUnit, { ...validation, sha256: 'b'.repeat(64) }, draft);
    expect(review.history.at(-1)!.items[0].actor).toBe('测试员');
    expect(review.items.every(item => item.status === 'pending')).toBe(true);
  });
  it('does not inherit another garment position’s human decisions', () => {
    const { unit, artwork } = fixture();
    const other = { ...unit, placement: { ...unit.placement!, offsetX: 2 }, artwork: null };
    const review = reviewForAttachment(other, artwork.validation, artwork.draft);
    expect(review.items.every(i => i.status === 'pending')).toBe(true);
  });
});
