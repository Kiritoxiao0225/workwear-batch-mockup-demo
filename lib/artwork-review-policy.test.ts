import { expect, it } from 'vitest';
import { artworkMaterialIssue, artworkReviewDecision, reconstructionReviewRequirements } from './artwork-review-policy';
import { artworkSeparationPrompt } from './artwork-generation-background';
import type { ArtworkEditCheck } from './artwork-model-edits';

it.each([
  ['failed', 'material', 'color', true], ['failed', 'material', 'text', true],
  ['failed', 'material', 'structure', true], ['failed', 'material', 'background', true],
  ['failed', 'minor', 'structure', false], ['failed', 'material', 'layout', false],
  ['failed', 'material', 'other', false],
  ['uncertain', 'unknown', 'text', false], ['passed', 'none', 'color', false],
] as const)('separates %s / %s / %s by defect severity', (status, impact, category, blocks) => {
  expect(artworkMaterialIssue({ requirement: '保留原图', evidence: '可见证据', status, impact, category })).toBe(blocks);
});
it('keeps historical failures visible without turning them into a passed check', () => {
  expect(artworkMaterialIssue({ status: 'failed', requirement: '保留白字', evidence: '白字变藏青' })).toBe(true);
});
it('deduplicates the same evidence and keeps minor issues separate', () => {
  const severe: ArtworkEditCheck = { status: 'failed', impact: 'material', category: 'color', requirement: '保留白字', evidence: '白字变成深色。' };
  const decision = artworkReviewDecision({ version: 'artwork-edit-check-v1', sourceSha256: 'a', outputSha256: 'b', model: 'test',
    checks: [severe, { ...severe, requirement: '原配色不变' }, { ...severe, category: 'layout', evidence: '间距略有变化' }] });
  expect(decision.issueMessages).toEqual(['白字变成深色']);
  expect(decision.warningMessages).toEqual(['白字变成深色', '间距略有变化']);
  expect(decision.issues[0].status).toBe('failed');
});
it('includes the full brief once instead of multiplying overlapping checks', () => {
  const requirements = reconstructionReviewRequirements('左胸标识', '保留白色文字和橙色笔画');
  expect(requirements).toHaveLength(5);
  expect(requirements.filter(item => item.includes('保留白色文字和橙色笔画'))).toHaveLength(1);
});
it.each(['输出纯白背景（#FFFFFF）的 PNG', '背景为纯白色 #FFFFFF', '纯白背景', '画布背景为白色'])('separates white artwork from staging background: %s', ending => {
  const result = artworkSeparationPrompt(`保留白色文字、橙色笔画。${ending}`);
  expect(result).toContain('保留白色文字、橙色笔画'); expect(result).toContain('禁止白字变深色');
  expect(result).not.toContain(ending); expect(artworkSeparationPrompt(result)).toBe(result);
});
