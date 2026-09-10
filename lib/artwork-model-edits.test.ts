import { describe, expect, it } from 'vitest';
import { artworkModelEdits, artworkGraphicRemovals } from './artwork-model-edits';
import { artworkRequirementFacts, artworkMethodIssue, standardArtworkPrompts } from './artwork-routing-request';
import { parseArtworkPreparationRequest } from './task-review-artwork';

const instruction = '后背使用图2完整图案，放大主体字体查看并清晰重制；将字体外侧的红色描边改成深蓝色，将原深蓝色底色调浅，其他内容与颜色保持图2原样。';
const input = (requirement = instruction, exactText = '') => parseArtworkPreparationRequest({
  sourceRequirementText: requirement, instruction: requirement, exactText, primaryImageLabel: '图2',
  image: { dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/png', fileName: 'source.png' },
  generationPrompt: '保留图2完整图案，纯白背景。', enhancementMode: 'auto',
});

describe('existing bitmap edits versus simple composition', () => {
  it('keeps internal deletion and ordinary arc text in composition', () => {
    const request = input('去掉牙齿内部的眼睛和嘴巴，只保留牙齿外轮廓，上方添加圆弧文字“小景是牙医”', '小景是牙医');
    expect(artworkGraphicRemovals(request)).toEqual(['去掉牙齿内部的眼睛和嘴巴', '只保留牙齿外轮廓']);
    expect(artworkRequirementFacts(request)).toMatchObject({ intent: 'compose', blockers: [] });
    expect(artworkRequirementFacts({ ...request, instruction: request.instruction + '，禁止重绘' }).blockers).toContain('严格保真要求禁止模型改图，请先提供已删除指定内部元素的主体素材');
  });
  it.each(['去掉白色背景', '清除中间的旧文字', '删除图案下方文字', '不要把眼睛去掉', '无需删除内部图案', '不保留背景', '删除这条提示'])(
    'does not purchase foreground editing for %s', instruction => {
      expect(artworkGraphicRemovals(input(instruction))).toEqual([]);
    });
  it('never treats reference-only graphics or the supplied new text as deletion instructions', () => {
    expect(artworkGraphicRemovals({ ...input('删除内部眼睛'), primaryImageRole: 'reference' })).toEqual([]);
    expect(artworkGraphicRemovals(input('添加文字“去掉眼睛”', '去掉眼睛'))).toEqual([]);
  });
  it('routes the anniversary outline and backing edits together, keeping every instruction in the model request', () => {
    const request = input();
    expect(artworkRequirementFacts(request)).toMatchObject({ intent: 'generate', blockers: [], editSpecification: 'complete' });
    const prompt = standardArtworkPrompts(request).generate;
    expect(prompt).toContain(instruction);
    expect(prompt).toContain('将字体外侧的红色描边改成深蓝色');
    expect(prompt).toContain('将原深蓝色底色调浅');
    expect(artworkModelEdits(request)).toHaveLength(2);
    expect(artworkMethodIssue(request, 'compose')).toContain('模型编辑');
  });
  it.each(['把红色轮廓变成深蓝色', '红线变蓝', '把描边改深蓝', '把底形颜色调浅', 'Logo改为蓝色，星星改为黄色', '把原图字体改成绿色'])(
    'uses image editing for unsupported bitmap edits: %s', requirement => {
      expect(artworkRequirementFacts(input(requirement)).intent).toBe('generate');
    });
  it.each([
    ['Logo改为绿色', '', 'compose'],
    ['图2下面添加文字，文字改成绿色', '测试文字', 'compose'],
    ['Logo改成绿色，新增文字改成白色', '测试文字', 'compose'],
    ['保留原图，红描边保持不变，底色不要调浅', '', 'preserve'],
    ['图2去掉白色背景', '', 'preserve'],
  ])('retains the existing route for %s', (requirement, exactText, intent) => {
    expect(artworkRequirementFacts(input(requirement, exactText)).intent).toBe(intent);
  });
  it('does not confuse a description of red outlines with an instruction to change them', () => {
    expect(artworkRequirementFacts({ ...input('保留图2原图'), layoutNote: '浅蓝字体带红色描边，后面有深蓝底形' }).intent).toBe('preserve');
  });
  it('retains an explicit prohibition on model redraw', () => {
    expect(artworkRequirementFacts(input(`${instruction}禁止重绘`)).blockers).toContain('严格保真与整图生成要求冲突，请先明确制作方式');
  });
});
