import { describe, expect, it } from 'vitest';
import { artworkModelEdits } from './artwork-model-edits';
import { artworkRequirementFacts, artworkMethodIssue, standardArtworkPrompts } from './artwork-routing-request';
import { parseArtworkPreparationRequest } from './task-review-artwork';

const instruction = '后背使用图2完整图案，放大主体字体查看并清晰重制；将字体外侧的红色描边改成深蓝色，将原深蓝色底色调浅，其他内容与颜色保持图2原样。';
const input = (requirement = instruction, exactText = '') => parseArtworkPreparationRequest({
  sourceRequirementText: requirement, instruction: requirement, exactText, primaryImageLabel: '图2',
  image: { dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/png', fileName: 'source.png' },
  generationPrompt: '保留图2完整图案，纯白背景。', enhancementMode: 'auto',
});

describe('existing bitmap edits versus simple composition', () => {
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
