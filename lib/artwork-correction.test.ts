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
it('keeps legacy correction summaries readable and uses the requested target for edits', () => {
  const report = { contentReview: { verification: { checks: [
    { requirement: '将旧名称替换成康悦。以下为完整制作背景：' + '背景'.repeat(500), status: 'failed', category: 'text', sourceObservation: '家帮到', resultObservation: '家帮到下方另加康悦', evidence: '旧字没有删除' },
    { requirement: '将文字改为白色', status: 'failed', category: 'color', sourceObservation: '红色', resultObservation: '红色', expected: '白色文字', correction: '仅将文字填充改为白色', evidence: '没有改色' },
  ] } } } as ArtworkRoutingReport;
  const issues = artworkCorrectionIssues(report);
  expect(issues[0].location).toBe('文字区域');
  expect(issues[0].expected).toContain('替换成康悦');
  expect(issues[0].expected.length).toBeLessThan(100);
  expect(issues[0].action).not.toContain('完整制作背景');
  expect(issues[1].expected).toBe('白色文字');
  expect(artworkCorrectionPrompt(issues, '添加康悦')).toContain('已按客户要求排好的目标文字须保留');
});
