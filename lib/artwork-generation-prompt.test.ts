import { describe, expect, it } from 'vitest';
import { compileGenerationPrompt, parseGenerationPrompt } from '@/lib/artwork-generation-prompt';
import { standardArtworkPrompts, artworkRequirementFacts } from '@/lib/artwork-routing-request';
import { parseArtworkPreparationRequest } from '@/lib/task-review-artwork';

const image = { fileName: 'source.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' };
const body = '使用图5校名字标；参照图4胸前印花，左侧大字“研”保持舒展笔锋，校名在中间，2026 在右侧，整组紧凑横排。纯白背景。';
const request = () => parseArtworkPreparationRequest({ sourceRequirementText: 'POLO：研+图5+2026【参考图四】', generationPrompt: body,
  instruction: '旧摘要：红色衣服', layoutNote: '旧模板：原文未说明大小与间距，图4用途不明', primaryImageLabel: '图5', image,
  referenceImages: [{ label: '图4', image }], exactText: '研 2026', sourceScope: 'subject', processingRoute: 'model' });

describe('single generation prompt contract', () => {
  it('preserves the authored body verbatim and adds only actual input labels', () => {
    const prompt = standardArtworkPrompts(request());
    expect(prompt.generate).toBe(`【输入图片对应关系】正文图号均为 WPS 原图号。\n输入图1 = WPS 图5（内容素材）\n输入图2 = WPS 图4（参考素材）\n\n${body}`);
    expect(prompt.generate).not.toContain('旧模板');
    expect(artworkRequirementFacts(request())).toMatchObject({ intent: 'generate', blockers: [], editSpecification: 'complete' });
  });
  it('keeps the main source first and maps every additional image deterministically', () => {
    const input = request();
    input.generationPrompt = '图5为主要内容，参考图4、图1、图3的布局与样式，纯白背景。';
    input.referenceImages = ['图4', '图1', '图3'].map(label => ({ label, image }));
    const parsed = parseArtworkPreparationRequest(input);
    expect(standardArtworkPrompts(parsed).imageMapping.map(mapping => mapping.sourceLabel)).toEqual(['图5', '图1', '图3', '图4']);
  });
  it('blocks missing images and invalid prompt types before any provider call', () => {
    expect(() => compileGenerationPrompt('参考图4', [{ sourceLabel: '图5', modelInputLabel: '图1', role: 'content' }])).toThrow('未附上的图4');
    expect(() => parseGenerationPrompt({ text: 'prompt' })).toThrow('4000');
    expect(() => parseGenerationPrompt('a'.repeat(4001))).toThrow('4000');
  });
  it('invalidates the displayed prompt hash when the body or input mapping changes', () => {
    const input = request();
    expect(standardArtworkPrompts({ ...input, generationPrompt: body + ' 年份稍小。' }).hash).not.toBe(standardArtworkPrompts(input).hash);
    expect(() => standardArtworkPrompts({ ...input, referenceImages: [] })).toThrow('未附上的图4');
  });
});
