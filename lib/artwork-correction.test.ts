import { expect, it } from 'vitest';
import { artworkCorrectionIssues, artworkCorrectionPrompt } from './artwork-correction';
import type { ArtworkRoutingReport } from './artwork-routing-standard';
it('deduplicates actual problems and forwards concrete observations without treating uncertainty as fact', () => {
  const check = { requirement: '保留白色文字', sourceObservation: '白色斜体', resultObservation: '深蓝色正体', status: 'failed', evidence: '文字颜色改变', location: 'WANDON 三行字', correction: '恢复白色和斜体', preserve: '保留橙色笔画和三行布局' };
  const report = { contentReview: { verification: { checks: [check, { ...check, requirement: '原配色不变' }, { ...check, status: 'uncertain', location: '弧线第2字', sourceObservation: null, resultObservation: null, correction: '对照原图核对，不能猜字' }] } } } as ArtworkRoutingReport;
  const issues = artworkCorrectionIssues(report);
  expect(issues).toHaveLength(2);
  expect(issues[1].uncertain).toBe(true);
  const prompt = artworkCorrectionPrompt([issues[0]], '保留 WANDON 原设计');
  expect(prompt).toContain('深蓝色正体'); expect(prompt).toContain('恢复白色和斜体'); expect(prompt).toContain('保留橙色笔画');
  expect(prompt).not.toContain('弧线第2字');
  expect(artworkCorrectionPrompt(issues, '准确文字为康悦', 'reference')).toContain('仅为样式参考，不得复制其文字或图形');
});
