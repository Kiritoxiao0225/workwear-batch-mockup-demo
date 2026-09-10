import { expect, it } from 'vitest';
import { artworkTextOperation, artworkTextRemovalChecks, artworkTextStyle } from './artwork-text-contract';
import { standardArtworkPrompts } from './artwork-routing-request';

const input = { instruction: '左胸使用图一，只保留Logo主体，将Logo下方原文字替换为“康悦”，其余Logo图形、结构和原有配色保留。',
  layoutNote: '上方为较大的盾牌形居家服务标识，下方为一行文字。盾牌外框为粗线深蓝色，内部由青绿色房屋轮廓、定位标记及橙色圆点组成；新文字“康悦”沿用原下方文字的深蓝色、粗重几何中文字体视觉风格，字形方正有力，与上方图形保持清晰间距和协调宽度。', exactText: '康悦' };

it.each([
  [input.instruction, 'replace'],
  ['下面的字都改成康悦', 'replace'],
  ['下面改成康悦', 'replace'],
  ['改为康悦', 'replace'],
  ['将旧字改成康悦但不要改变图形', 'replace'],
  ['删除原文字，新增康悦', 'replace'],
  ['替换旧文字，目标内容按准确文字填写', 'replace'],
  ['将“到家帮”换成“康悦”，保留注册标记', 'replace'],
  ['保留原文字，在下方添加“康悦”', 'add'],
  ['不要替换原文字，下方加“康悦”', 'add'],
  ['不要把旧字改成康悦', 'add'],
  ['添加“康悦”，字体改成黑体', 'add'],
  ['文字颜色改成蓝色，下方添加“康悦”', 'add'],
  ['图一+康悦', 'add'],
] as const)('separates replacement from addition: %s', (instruction, expected) => {
  expect(artworkTextOperation({ ...input, instruction, layoutNote: '' })).toBe(expected);
});

it('never erases content from a reference-only image or a task without target text', () => {
  expect(artworkTextOperation({ ...input, primaryImageRole: 'reference' })).toBe('add');
  expect(artworkTextOperation({ ...input, exactText: '' })).toBe('none');
});

it('does not leak whole-logo descriptions or unrelated palette into text generation', () => {
  const prompts = standardArtworkPrompts({ ...input, sourceRequirementText: input.instruction,
    primaryImageLabel: '图1', sourceScope: 'subject', processingRoute: 'auto', referenceImages: [] });
  expect(prompts.textOperation).toBe('replace');
  expect(prompts.removeText).toContain('只删除');
  expect(prompts.removeText).toContain('不要绘制它');
  expect(prompts.styledTexts[0].prompt).not.toMatch(/盾牌|房屋|定位|橙色|青绿色|到家帮|上下组合|上方图形/);
  expect(prompts.styledTexts[0].prompt).toContain('康悦');
  expect(artworkTextStyle(input)).toMatchObject({ colors: ['深蓝色'], styles: expect.arrayContaining(['粗重', '几何', '方正']) });
  expect(artworkTextRemovalChecks(input).join('\n')).toContain('未被指定替换');
});

it('keeps typography attributes while excluding a red garment and a green logo', () => {
  expect(artworkTextStyle({ instruction: '红色衣服，Logo绿色，新增文字使用蓝色书法字体，字距 8px', layoutNote: '', exactText: 'ABC' }))
    .toEqual({ styles: ['书法'], colors: ['蓝色'], spacing: ['字距 8px'] });
});

it('resolves each version from its own instruction even when the source order requests another operation', () => {
  const prompts = standardArtworkPrompts({ ...input, instruction: '图二保留原字，新增“康悦”', layoutNote: '', sourceRequirementText: input.instruction,
    primaryImageLabel: '图2', sourceScope: 'subject', processingRoute: 'auto', referenceImages: [] });
  expect(prompts.textOperation).toBe('add');
  expect(prompts.removeText).toBeNull();
});
