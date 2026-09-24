import { describe, expect, it } from 'vitest';
import { authoredPrompt } from './saas-requirement-editor';

describe('studio background selection', () => {
  it('defaults to preserving a requested scene and only requests transparency when checked', () => {
    const text = '帮我把热水袋换成实际使用的场景';
    expect(authoredPrompt(text)).toContain(text);
    expect(authoredPrompt(text)).toContain('保留背景或使用场景');
    expect(authoredPrompt(text)).not.toContain('输出透明背景 PNG');
    expect(authoredPrompt(text, true)).toContain('输出透明背景 PNG');
  });
  it('updates seven-field defaults without duplicating settings or dropping authored details', () => {
    const prompt = authoredPrompt('换成卧室场景', true).replace('客户未指定尺寸', '宽 1200 像素');
    const unchecked = authoredPrompt(prompt, false);
    expect(unchecked).toContain('宽 1200 像素');
    expect(unchecked).not.toContain('输出透明背景 PNG');
    expect(unchecked.match(/背景设置：/g)).toHaveLength(1);
    expect(authoredPrompt(unchecked, false)).toBe(unchecked);
    const legacy = unchecked.replace(/输出：[\s\S]*$/, '输出：一张独立透明底 PNG 图稿，不包含服装或效果图模板。');
    expect(authoredPrompt(legacy, false)).not.toContain('独立透明底');
  });
});
