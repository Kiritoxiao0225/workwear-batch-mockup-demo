import { describe, expect, it } from 'vitest';
import { artworkReferenceColors } from './artwork-reference-color';
import { artworkEditColor, artworkRequirementFacts, type ArtworkRequirementInput } from './artwork-routing-request';

const request = (instruction: string, label = '图3', layoutNote = ''): ArtworkRequirementInput => ({
  instruction, layoutNote, exactText: '', primaryImageLabel: '图1', sourceScope: 'subject', processingRoute: 'auto', referenceImages: [{ label }],
});

describe('reference-backed artwork colors', () => {
  it.each([
    ['将图案原黑色统一改为图3所示的深蓝色。', '图3'],
    ['左胸使用图一完整标识，保留原有图形、文字和排版，整体改为图二标志所示的绿色。', '图2'],
    ['将整组前景统一改成WPS图2中主标志及“梦想电车”文字使用的高亮荧光绿色。', '图2'],
    ['图案颜色要图三的那种深蓝', '图3'],
  ])('keeps %s as a reference instead of a preset', (instruction, label) => {
    const input = request(instruction, label);
    expect(artworkReferenceColors(input).map(reference => reference.label)).toEqual([label]);
    expect(artworkEditColor(instruction)).toBeNull();
    expect(artworkRequirementFacts(input)).toMatchObject({ intent: 'compose', blockers: [], editSpecification: 'complete' });
  });
  it('deduplicates the same color reference in the instruction and layout', () => {
    expect(artworkReferenceColors(request('将图案改为图3的深蓝色', '图3', '颜色参考WPS图三胸前印花'))).toHaveLength(1);
  });
  it('requires the actual referenced image for both C and D', () => {
    const input = { ...request('将图案改为图3的深蓝色'), referenceImages: [] };
    expect(artworkRequirementFacts(input).blockers).toContain('颜色参考图3尚未绑定，请补充该素材');
    expect(artworkRequirementFacts({ ...input, processingRoute: 'model' }).blockers).toContain('颜色参考图3尚未绑定，请补充该素材');
  });
  it('does not mistake source colors, font references or exclusions for color requests', () => {
    for (const instruction of ['使用图1黑色Logo，保留原色', '保留图1，字体参考图3', 'Logo改为深蓝色，不要用图3的颜色']) {
      expect(artworkReferenceColors(request(instruction))).toEqual([]);
    }
    expect(artworkRequirementFacts(request('Logo改为深蓝色，不要用图3的颜色')).blockers).toEqual([]);
    expect(artworkEditColor('Logo改为深蓝色')).toBe('#173f82');
    expect(artworkEditColor('Logo改为#184266')).toBe('#184266');
  });
});
