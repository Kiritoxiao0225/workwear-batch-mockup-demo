import { describe, expect, it } from 'vitest';
import { DEMO_MATERIAL } from '../listing/demo/material';
import { defaultDraft } from '../listing/draft';
import { BUILT_IN_LAYOUTS, FLAT_EXAMPLE, fitTemplate, type Layout } from '../listing/templates';
import { planJobs, wordsOf } from './listing-generation';
import { castPrompt, editPrompt, mainPrompt, skuPrompt } from './listing-prompts';
import type { StoredPlan } from './listing-store';

const commute = BUILT_IN_LAYOUTS[0];
const flat: Layout = { ...FLAT_EXAMPLE, id: 'flat', samples: [] };
const stored = (layout = commute): StoredPlan => {
  const draft = { ...defaultDraft(DEMO_MATERIAL, layout), extra: [{ color: '北欧蓝', layout: '' }] };
  return { draft, garment: ['立领'], scenes: { 'square:1': '写字楼大堂' }, sku: { tag: '男女同款', fabric: '三防面料' },
    colors: draft.colors.map(c => ({ name: c.name, hex: c.hex, sku: c.pick! })), direct: ['M31'], images: [], model: 'm', round: 1 };
};

describe('planJobs', () => {
  it('round one: product images, the cast, SKU images built on the cast, then the square images', () => {
    const jobs = planJobs(stored(), commute, 1), by = new Map(jobs.map(j => [j.slot, j]));
    expect(jobs.map(j => j.slot).slice(0, 7)).toEqual(['product:M30', 'product:M31', 'product:M32', 'product:M33', 'product:M34', 'product:M35', 'cast']);
    expect(jobs.filter(j => j.slot.startsWith('square')).map(j => j.slot)).toEqual(['square:1', 'square:2', 'square:3', 'square:4', 'square:5', 'square:1+M32']);
    expect(by.get('product:M31')).toMatchObject({ free: true, input: { direct: true } });
    expect(by.get('cast')!.depends).toEqual(['product:M30']);
    expect(by.get('sku:M31')!.depends).toEqual(['product:M31', 'cast', 'sku:M30']);
    // An image with people waits for the cast; the close-up image (no people) does not.
    expect(by.get('square:1')!.depends).toEqual(['product:M30', 'cast']);
    const detail = jobs.find(j => j.input.kind === 'main' && j.input.index === 2)!;
    expect(detail.depends).not.toContain('cast');
    expect(by.get('square:5')).toMatchObject({ multi: true });
    expect(by.get('square:1+M32')).toMatchObject({ depends: ['product:M32', 'cast'], input: { colors: ['北欧蓝'], index: 0 } });
  });
  it('round two: the 3:4 images and the long image', () => {
    expect(planJobs(stored(), commute, 2).map(j => j.slot)).toEqual(['portrait:1', 'portrait:2', 'portrait:3', 'portrait:4', 'portrait:5', 'portrait:1+M32', 'long:1', 'long:1+M32']);
  });
  it('a layout without people has no cast', () => {
    expect(planJobs(stored(flat), flat, 1).some(j => j.slot === 'cast')).toBe(false);
  });
  it('one extra set added later remakes only its covers', () => {
    expect(planJobs(stored(), commute, 1, 'M32').map(j => j.slot)).toEqual(['square:1+M32']);
  });
  it('an image is made with the words of its points', () => {
    const s = stored(), i = s.draft.slots.findIndex(x => x.task === '细节');
    expect(wordsOf(s.draft, i).cells.map(c => c.caption)).toEqual(['利落立领', '顺手拉链', '贴腕袖口']);
  });
});

describe('prompts', () => {
  const colors = [{ name: '落霞橙', hex: '#d98a1c' }];
  it('writes each zone where it is, with its words and picture, and the cast as the people', () => {
    const t = fitTemplate(commute.templates.功能.square, 2);
    const prompt = mainPrompt({ ratio: 'square', task: '功能', template: t, layout: commute, used: colors, all: colors, garment: ['立领'], lead: '男', fromSku: false, cast: 2, n: 2, total: 5,
      content: { title: '三防面料 雨天不怕', sub: '', tags: ['抗撕裂'], cells: [{ text: '水珠易擦净', recipe: '面料上挂着水珠' }, { text: '透气好活动', recipe: '热水杯上冒蒸汽' }], act: '模特抬起手臂淋水', scene: '办公室' } });
    expect(prompt).toContain('大标题「三防面料 雨天不怕」：区域 左4% 上5% 宽34% 高10%');
    expect(prompt).toContain('卡片里画：面料上挂着水珠；卡片底部一行字「水珠易擦净」');
    expect(prompt).toContain('只有一位模特：参考图2里的男生');
    expect(prompt).toContain('动作：模特抬起手臂淋水');
    expect(prompt).not.toContain('小字「');
  });
  it('an image without people says so and shows how the garment lies', () => {
    const prompt = mainPrompt({ ratio: 'square', task: '首图', template: flat.templates.首图.square, layout: flat, used: colors, all: colors, garment: ['立领'], lead: '男', fromSku: false, cast: null,
      content: { title: '轻盈抗造工作服', sub: '', tags: [], cells: [], scene: '' } });
    expect(prompt).toContain('画面里没有任何人');
    expect(prompt).toContain('平铺在台面上');
  });
  it('the cast is one man and one woman; a SKU image copies the first one and draws from the cast', () => {
    expect(castPrompt({ color: '落霞橙', garment: ['立领'] })).toContain('一男一女');
    const sku = skuPrompt({ layout: commute, color: '黑色', tag: '男女同款', fabric: '', garment: ['立领'], lead: '男', cast: 2, anchor: 3, anchorColor: '落霞橙' });
    expect(sku).toContain('参考图3是同一套 SKU 图里已经做好的「落霞橙」那张');
    expect(sku).toContain('一男一女两位模特：就是参考图2里的两个人');
    expect(sku).not.toContain('面料小图');
  });
  it('a 画板 change redraws only its box', () => {
    const prompt = editPrompt({ ratio: 'square', box: [51, 59, 47, 38], what: '把这里原来的字换成「水珠易擦净」', style: commute.style });
    expect(prompt).toContain('只重画遮罩透明的那一块（区域 左51% 上59% 宽47% 高38%）');
    expect(prompt).toContain('框外的人物、衣服、文字、背景全部保持原样');
  });
});
