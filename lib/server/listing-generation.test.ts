import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEMO_MATERIAL } from '../listing/demo/material';
import { defaultDraft } from '../listing/draft';
import { LEGACY_LAYOUTS as BUILT_IN_LAYOUTS } from '../listing/legacy-layouts';
import { SERVICE_IMAGES } from '../listing/service';
import { BUILT_IN_LAYOUTS as MASTERS, FLAT_EXAMPLE, fitTemplate, type Layout } from '../listing/templates';
import { coverOf, fabricCrop, planJobs, wordsOf, zipEntryName } from './listing-generation';
import { castOnePrompt, castPrompt, editPrompt, longPrompt, mainPrompt, redrawPrompt, servicePrompt, serviceWordsPrompt, skuPrompt } from './listing-prompts';
import type { StoredPlan } from './listing-store';

const commute = BUILT_IN_LAYOUTS[0];
const flat: Layout = { ...FLAT_EXAMPLE, id: 'flat', samples: [] };
const stored = (layout = commute): StoredPlan => {
  const draft = { ...defaultDraft(DEMO_MATERIAL, layout), extra: [{ color: '北欧蓝', layout: '' }] };
  return { draft, garment: ['立领'], scenes: { 'square:1': '写字楼大堂' }, sku: { tag: '男女同款', fabric: '三防面料' },
    colors: draft.colors.map(c => ({ name: c.name, hex: c.hex, sku: c.pick! })), direct: ['M31'], images: [], model: 'm', round: 1 };
};

describe('castOnePrompt', () => {
  it('draws one person from their photo without what they wear, or makes one up', () => {
    const from = castOnePrompt({ color: '爱马仕橙', garment: ['立领'], who: '女', photo: true });
    expect(from).toContain('参考图2是素材里的女生模特照片');
    expect(from).toContain('不要美化');
    expect(from).toContain('只有一位女生');
    const made = castOnePrompt({ color: '爱马仕橙', garment: ['立领'], who: '男', photo: false });
    expect(made).not.toContain('参考图2');
    expect(made).toContain('短黑发');
  });
});

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
    const detail = jobs.find(j => j.input.kind === 'main' && j.input.index === 3)!;
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
  it('a cast drawn from the material: each person alone, then put together for free', () => {
    const s = stored();
    s.draft = { ...s.draft, model: { lead: '男', photos: { 男: 'M40' } } };
    const by = new Map(planJobs(s, commute, 1).map(j => [j.slot, j]));
    expect(by.get('cast:男')).toMatchObject({ input: { kind: 'cast', who: '男', photo: 'M40' }, depends: ['product:M30'] });
    expect(by.get('cast:女')!.input).toEqual({ kind: 'cast', who: '女' });
    expect(by.get('cast')).toMatchObject({ input: { pair: true }, depends: ['cast:男', 'cast:女'], free: true });
    expect(by.get('square:1')!.depends).toEqual(['product:M30', 'cast']);
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

describe('the masters', () => {
  const master = (id: string) => MASTERS.find(l => l.id === id)!;
  it('every master puts its SKU images together for free, each colour on a model: its own photo, else the lead drawn in it (paid)', () => {
    expect(MASTERS.every(l => l.sku.specCard && l.sku.people === 0)).toBe(true);
    const s = { ...stored(master('M1')), draft: { ...defaultDraft(DEMO_MATERIAL, master('M1')), extra: [] } };
    const by = new Map(planJobs({ ...s, photos: {} }, master('M1'), 1).map(j => [j.slot, j]));
    expect(by.get('skumodel:M31')).toMatchObject({ input: { kind: 'skuModel', sku: 'M31' }, depends: ['product:M31', 'cast'] });
    expect(by.get('skumodel:M31')?.free).toBeFalsy();
    expect(by.get('sku:M31')).toMatchObject({ input: { kind: 'sku', sku: 'M31', card: true }, depends: ['product:M31', 'skumodel:M31'], free: true });
    expect(by.has('cast')).toBe(true);
    const own = new Map(planJobs({ ...s, photos: { M31: 'M9' } }, master('M1'), 1).map(j => [j.slot, j]));
    expect(own.has('skumodel:M31')).toBe(false);
    expect(own.get('sku:M31')).toMatchObject({ depends: ['product:M31'], free: true });
  });
  it('a master whose cover has two people draws the man and the woman on the SKU images; one with one person, the lead', () => {
    const at = (id: string, model?: { lead: '男' | '女'; photos?: { 男?: string; 女?: string } }) => { const s = stored(master(id)); return new Map(planJobs({ ...s, photos: {}, draft: { ...defaultDraft(DEMO_MATERIAL, master(id)), extra: [], ...(model ? { model } : {}) } }, master(id), 1).map(j => [j.slot, j])); };
    expect(at('M4').get('skumodel:M31')).toMatchObject({ input: { kind: 'skuModel', pair: true }, depends: ['product:M31', 'cast'] });
    expect(at('M4', { lead: '男', photos: { 男: 'M9' } }).get('skumodel:M31')?.depends).toEqual(['product:M31', 'cast:男', 'cast:女']);
    expect(at('M1').get('skumodel:M31')?.input).not.toHaveProperty('pair');
    expect(at('M1', { lead: '女', photos: { 女: 'M9' } }).get('skumodel:M31')?.depends).toEqual(['product:M31', 'cast:女']);
  });
  const plan = (id: string, scene?: { place: string; sell: string }): StoredPlan => ({ ...stored(master(id)), draft: { ...stored(master(id)).draft, extra: [], ...(scene ? { scene } : {}) } });
  it('every 3:4 image is its square one laid out again; with people or the whole garment the colour\'s white image comes too', () => {
    const two = new Map(planJobs(plan('M4'), master('M4'), 2).map(j => [j.slot, j]));
    for (const k of [1, 2, 3, 4, 5]) expect(two.get(`portrait:${k}`)?.input).toMatchObject({ kind: 'relayout', from: `square:${k}` });
    expect(two.get('portrait:1')?.depends).toEqual(['square:1', expect.stringMatching(/^product:/)]);
    expect(two.get('portrait:3')?.depends).toEqual(['square:3']);
    expect(two.get('portrait:4')?.depends).toEqual(['square:4']);
  });
  it('the 2:3 long image is the square cover laid out again, with the cast when the set has people', () => {
    const long = (id: string) => planJobs(plan(id), master(id), 2).find(j => j.slot === 'long:1');
    expect(long('M3')).toMatchObject({ input: { kind: 'relayout', from: 'square:1', ratio: 'long', index: 0, cast: true }, depends: ['square:1', expect.stringMatching(/^product:/), 'cast'] });
    expect(long('M5')?.input).toMatchObject({ kind: 'relayout', from: 'square:1', ratio: 'long' });
    expect(long('M5')?.input).not.toHaveProperty('cast');
    expect(longPrompt({ garment: true, cast: 3 })).toContain('参考图3是模特定妆照');
  });
  it('the second image copies the shop\'s service image of the master for free; its 3:4 one lays that out again', () => {
    const one = planJobs(plan('M3'), master('M3'), 1), two = planJobs(plan('M3'), master('M3'), 2);
    expect(one.find(j => j.slot === 'square:2')).toMatchObject({ free: true, depends: [], input: { kind: 'copy', image: 'D-warm' } });
    expect(two.find(j => j.slot === 'portrait:2')).toMatchObject({ depends: ['square:2'], input: { kind: 'relayout', from: 'square:2' } });
    expect(planJobs(plan('M1'), master('M1'), 1).find(j => j.slot === 'square:2')?.input).toMatchObject({ image: 'A-light' });
  });
  it('the cover acts out its point where it is worn, only on masters shot on location and in places they allow', () => {
    expect(coverOf(plan('M3', { place: '工地', sell: '防水' }).draft, master('M3'))).toMatchObject({ bg: expect.stringContaining('建筑工地'), person: expect.stringContaining('水珠') });
    expect(coverOf(plan('M4', { place: '工地', sell: '防水' }).draft, master('M4'))).toBeNull();
    expect(coverOf(plan('M1', { place: '登山', sell: '防水' }).draft, master('M1'))).toBeNull();
  });
  const colors = [{ name: '爱马仕橙', hex: '#e8621d' }, { name: '石苔灰', hex: '#9a9c94' }];
  const content = { title: '轻量防水面料', sub: '', tags: ['90%锦纶'], cells: [], scene: '' };
  it('an image of fabric only is made from a piece of the fabric and draws no garment', () => {
    const t = master('M4').templates.功能.square;
    expect(t.fabricOnly).toBe(true);
    const prompt = mainPrompt({ ratio: 'square', task: '功能', template: t, layout: master('M4'), content, used: colors.slice(0, 1), all: colors, garment: ['连帽'], lead: '男', fromSku: false, cast: null, fabric: true, logo: null });
    expect(prompt).toContain('面料的一小块特写');
    expect(prompt).not.toContain('衣服（必须和参考图一模一样）');
    expect(prompt).toContain('大标题「轻量防水面料」：区域 左4% 上13% 宽58% 高9%，字高约占画面 7%');
  });
  it('the chest shows the LOGO the plan chose; several colours stand in a light studio', () => {
    const t = master('M2').templates.收口.square;
    const prompt = mainPrompt({ ratio: 'square', task: '收口', template: t, layout: master('M2'), content: { ...content, title: '团体定制 2色可选' }, used: colors, all: colors, garment: ['连帽'], lead: '男', fromSku: true, cast: 3, logo: '衣服胸口左侧印一个小小的白色「LOGO」字样' });
    expect(prompt).toContain('胸口左侧印一个小小的白色「LOGO」');
    expect(prompt).toContain('浅灰无缝棚拍底');
    expect(mainPrompt({ ratio: 'square', task: '首图', template: master('M1').templates.首图.square, layout: master('M1'), content: { ...content, title: '防水', sub: '冲锋衣定制' }, used: colors.slice(0, 1), all: colors, garment: ['连帽'], lead: '男', fromSku: false, cast: 2, logo: null }))
      .toContain('大标题「防水」：区域 左76% 上58% 宽17% 高22%，竖排，从上到下一列，每个字高约占画面 9.5%');
  });
  it('a piece of fabric is cut from the product image', async () => {
    const product = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } }).composite([{ input: { create: { width: 200, height: 260, channels: 3, background: '#e8621d' } }, left: 100, top: 70 }]).png().toBuffer();
    const crop = await sharp(await fabricCrop(product)).raw().toBuffer({ resolveWithObject: true });
    expect(crop.info).toMatchObject({ width: 512, height: 512 });
    expect([crop.data[0], crop.data[1], crop.data[2]]).toEqual([0xe8, 0x62, 0x1d]);
  });
  it('the service images write the shop\'s words on the sample\'s layout; a change redraws only those words', () => {
    const dark = SERVICE_IMAGES.find(x => x.id === 'A-dark')!;
    expect(servicePrompt(dark, ['免费看样｜满意再下单', '可开发票｜普票专票都行'], false)).toContain('右上权益卡：「可开发票」「普票专票都行」');
    expect(serviceWordsPrompt([{ from: '免费看样｜满意再下单', to: '可开发票｜普票专票都行' }])).toContain('「免费看样」「满意再下单」 换成 「可开发票」「普票专票都行」');
    expect(redrawPrompt({ ratio: 'square', ask: '背景换成工地', reference: true })).toContain('参考图2是用户给的参考');
  });
});

describe('zip entry names from colour names', () => {
  it('keeps a typed name as one file, never a path out of the folder', () => {
    expect(zipEntryName('藏青')).toBe('藏青');
    expect(zipEntryName('../../x')).toBe('__.._x');
    expect(zipEntryName('a/b\\c:d')).toBe('a_b_c_d');
    expect(zipEntryName('..')).toBe('_');
    expect(zipEntryName('')).toBe('_');
  });
});
