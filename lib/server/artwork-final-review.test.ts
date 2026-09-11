import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { inspectFinalArtwork } from './artwork-final-review';
import { readProductionFile } from './production-storage';
import { verifyArtworkModelEdits } from './artwork-content-inspection';
import { buildArtworkReview } from '@/lib/artwork-review-ledger';
import { emptyWpsProductionState, importTaskReviews, type ArtworkValidation } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
vi.mock('./production-storage', () => ({ readProductionFile: vi.fn() }));
vi.mock('./artwork-content-inspection', () => ({ verifyArtworkModelEdits: vi.fn() }));
const final = Buffer.from('final pixels');
const sha256 = createHash('sha256').update(final).digest('hex');
function fixture() {
  const state = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[0]]);
  const unit = state.units[0], source = state.records[0].source;
  const ledger = buildArtworkReview(unit, { sha256, checkedAt: '2026-09-11T00:00:00Z' } as ArtworkValidation);
  return { unit, source, ledger };
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readProductionFile).mockResolvedValue(final); });
it('checks only requested pending content and reuses results without further requests', async () => {
  const { unit, source, ledger } = fixture();
  vi.mocked(verifyArtworkModelEdits).mockImplementation(async (_original, _final, requirements) => ({ version: 'artwork-edit-check-v1', sourceSha256: sha256, outputSha256: sha256, model: 'test',
    checks: requirements.map(requirement => ({ requirement, status: 'passed', evidence: '符合', category: 'other' })) }));
  const next = await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger);
  expect(verifyArtworkModelEdits).toHaveBeenCalledTimes(1);
  expect(next.items.filter(i => i.status === 'passed')).toHaveLength(5);
  expect(next.items.filter(i => i.status === 'pending').map(i => i.id)).toEqual(['size', 'position']);
  expect(await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', next)).toEqual(next);
  expect(verifyArtworkModelEdits).toHaveBeenCalledTimes(1);
  expect(vi.mocked(verifyArtworkModelEdits).mock.calls[0][2][0]).toContain('最终图案');
});
it('an unavailable inspector preserves image usability and uncertainty', async () => {
  const { unit, source, ledger } = fixture();
  vi.mocked(verifyArtworkModelEdits).mockRejectedValue(new Error('timeout'));
  const next = await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger, ['color']);
  expect(next.items.find(i => i.id === 'color')).toMatchObject({ status: 'uncertain', evidence: expect.stringContaining('timeout') });
  expect(next.sha256).toBe(ledger.sha256); expect(ledger.items[1].status).toBe('pending');
});
it('does not call a model with the wrong final bytes or no original', async () => {
  const { unit, source, ledger } = fixture();
  await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', { ...ledger, sha256: 'wrong' });
  await inspectFinalArtwork({ ...unit, materialId: null, referenceMaterialIds: [] }, { ...source, materials: [] }, '/uploads/logos/final.png', ledger);
  expect(verifyArtworkModelEdits).not.toHaveBeenCalled();
});
it('keeps explicit failures when a repeat check is unavailable', async () => {
  const { unit, source, ledger } = fixture(); ledger.items[1].status = 'failed'; ledger.items[1].evidence = '应白色，实际深蓝';
  vi.mocked(verifyArtworkModelEdits).mockRejectedValue(new Error('unavailable'));
  const next = await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger, ['color']);
  expect(next.items[1].status).toBe('failed'); expect(next.items[1].evidence).toContain('实际深蓝');
});

it('reference-only inputs stay references when checking the final combined image', async () => {
  const { unit, source, ledger } = fixture();
  unit.materialId = null; unit.referenceMaterialIds = [source.materials[0].id]; unit.textMode = 'replace'; unit.exactText = '康悦';
  vi.mocked(verifyArtworkModelEdits).mockImplementation(async (_a, _b, requirements) => ({ version: 'artwork-edit-check-v1', sourceSha256: sha256, outputSha256: sha256, model: 'test', checks: requirements.map(requirement => ({ requirement, status: 'uncertain', evidence: '字形看不清' })) }));
  await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger, ['text']);
  expect(vi.mocked(verifyArtworkModelEdits).mock.calls[0][2][0]).toContain('仅作样式参考，不复制其原文字或图形');
  expect(vi.mocked(verifyArtworkModelEdits).mock.calls[0][2][0]).toContain('明确文字：康悦');
});
