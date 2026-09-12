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
  // 候选修复重写了逐来源核对提示词：参考图声明改为角色化表述，准确文字统一为「准确新增文字」。
  expect(vi.mocked(verifyArtworkModelEdits).mock.calls[0][2][0]).toContain('图1仅提供样式参考，不要求复制它原有的文字、标志、衣服或背景');
  expect(vi.mocked(verifyArtworkModelEdits).mock.calls[0][2][0]).toContain('准确新增文字：康悦');
});

it('checks the target font against the designated reference rather than the content Logo', async () => {
  const { unit, source, ledger } = fixture();
  source.materials.push({ ...source.materials[0], id: 'font-ref', url: '/uploads/logos/font-ref.png' });
  unit.fontReference = { materialId: 'font-ref', origin: 'manual', description: '粗体方字', evidence: '人工指定', region: null };
  unit.referenceMaterialIds = ['font-ref'];
  const fontBytes = Buffer.from('font reference pixels');
  vi.mocked(readProductionFile).mockImplementation(async url => url.endsWith('font-ref.png') ? fontBytes : final);
  // 候选修复要求核对回执的 sourceSha256 必须等于实际送检原图的字节哈希（逐来源对照同一最终图）。
  const bytesSha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  vi.mocked(verifyArtworkModelEdits).mockImplementation(async (original, _final, requirements) => ({ version: 'artwork-edit-check-v1', sourceSha256: bytesSha(original), outputSha256: sha256, model: 'test',
    checks: requirements.map(requirement => ({ requirement, status: original === fontBytes ? 'failed' : 'passed', evidence: original === fontBytes ? '目标字笔画偏细' : '符合' })) }));
  const next = await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger, ['text']);
  expect(verifyArtworkModelEdits).toHaveBeenCalledTimes(2);
  expect(vi.mocked(verifyArtworkModelEdits).mock.calls[1][0]).toBe(fontBytes);
  // 候选修复为逐来源对照同一最终图：文字项的证据带来源前缀（[图1]=内容Logo 符合；[图2]=字体参考 偏细）。
  expect(next.items.find(item => item.id === 'text')).toMatchObject({ status: 'failed' });
  expect(next.items.find(item => item.id === 'text')?.evidence).toContain('目标字笔画偏细');
});

it.each([
  ['全部背景去除，圆内也透明', 'all-background'],
  ['仅去除外围白色背景，保留徽章底色', 'exterior'],
  ['保留原图案', 'legacy'],
] as const)('records the same explicit background contract in final review: %s', async (instruction, scope) => {
  const { unit, source, ledger } = fixture(); unit.instruction = instruction;
  unit.generationPrompt = '纯白背景输出；清除图案外围白色背景，保留内部留白';
  if (scope === 'legacy') unit.generationPrompt = '';
  vi.mocked(verifyArtworkModelEdits).mockImplementation(async (_a, _b, requirements) => ({ version: 'artwork-edit-check-v1', sourceSha256: sha256, outputSha256: sha256, model: 'test',
    checks: requirements.map(requirement => ({ requirement, status: 'passed', evidence: '按明确范围逐项核对符合' })) }));
  const next = await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger, ['background']);
  expect(next.items.find(item => item.id === 'background')?.status).toBe('passed');
  const scoped = next as typeof next & { backgroundContractKey: string };
  expect(JSON.parse(scoped.backgroundContractKey).scope).toBe(scope);
  expect(next.sha256).toBe(ledger.sha256); expect(next.history).toHaveLength(1);
  // Reviewing the background is not confirmation of placement or the other four content items.
  expect(next.items.filter(item => item.id !== 'background').map(item => item.status)).toEqual(ledger.items.filter(item => item.id !== 'background').map(item => item.status));
});
it('ambiguous inner background stays uncertain even when a model claims passed, without changing final bytes', async () => {
  const { unit, source, ledger } = fixture(); unit.instruction = '去除素材白色背景';
  vi.mocked(verifyArtworkModelEdits).mockImplementation(async (_a, _b, requirements) => ({ version: 'artwork-edit-check-v1', sourceSha256: sha256, outputSha256: sha256, model: 'test',
    checks: requirements.map(requirement => ({ requirement, status: 'passed', evidence: '模型认为背景符合' })) }));
  const next = await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger, ['background']);
  expect(next.items.find(item => item.id === 'background')).toMatchObject({ status: 'uncertain', evidence: expect.stringContaining('范围未明确') });
  expect(next.sha256).toBe(sha256); expect(ledger.items.find(item => item.id === 'background')?.status).toBe('pending');
});
it('a scope-version recheck leaves manually confirmed background and accepted registered-mark differences untouched', async () => {
  const { unit, source, ledger } = fixture(); unit.instruction = '全部背景去除，圆内也透明';
  for (const item of ledger.items) { item.status = 'confirmed'; item.actor = 'operator'; item.note = '已核对当前像素'; }
  const structure = ledger.items.find(item => item.id === 'structure')!;
  structure.status = 'accepted'; structure.evidence = '模型提示 R 标记可能变粗，人工未确认细微变化';
  const next = await inspectFinalArtwork(unit, source, '/uploads/logos/final.png', ledger);
  expect(next).toEqual(ledger); expect(verifyArtworkModelEdits).not.toHaveBeenCalled();
});
