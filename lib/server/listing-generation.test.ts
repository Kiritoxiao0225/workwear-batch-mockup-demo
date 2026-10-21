import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEMO_MATERIAL } from '../listing/demo/material';
import { defaultDraft, type Model, type SkuPeople } from '../listing/draft';
import { skuPhotos } from '../listing/sku-card';
import { LEGACY_LAYOUTS as BUILT_IN_LAYOUTS } from '../listing/legacy-layouts';
import { SERVICE_IMAGES } from '../listing/service';
import { BUILT_IN_LAYOUTS as MASTERS, FLAT_EXAMPLE, fitTemplate, type Layout } from '../listing/templates';
import { contentOf, coverOf, fabricCrop, LOGO_LINE, planJobs, wordsOf, zipEntryName } from './listing-generation';
import { buildPlan } from './listing-write';
import { castOnePrompt, castPrompt, editPrompt, longPrompt, mainPrompt, productPrompt, redrawPrompt, relayoutPrompt, servicePrompt, serviceWordsPrompt, skuModelPrompt, skuPrompt } from './listing-prompts';
import { crowdLine, DEFAULT_PLACE } from './listing-crowd';
import { SPECS, specPrompt } from './listing-specs';
import type { StoredPlan } from './listing-store';

const commute = BUILT_IN_LAYOUTS[0];
const flat: Layout = { ...FLAT_EXAMPLE, id: 'flat', samples: [] };
const stored = (layout = commute): StoredPlan => {
  const draft = { ...defaultDraft(DEMO_MATERIAL, layout), extra: [{ color: '北欧蓝', layout: '' }] };
  return { draft, garment: ['立领'], scenes: { 'square:1': '写字楼大堂' }, sku: { tag: '男女同款', fabric: '三防面料' },
    colors: draft.colors.map(c => ({ name: c.name, hex: c.hex, sku: c.pick! })), direct: ['M31'], images: [], model: 'm', round: 1 };
};

describe('the garment\'s own marks (10-19)', () => {
  it('the white image and the cast keep the badges and words the garment carries, adding none', () => {
    for (const p of [productPrompt({ color: '乌梅紫', garment: ['立领'] }), castPrompt({ color: '乌梅紫', garment: ['立领'] }), castOnePrompt({ color: '乌梅紫', garment: ['立领'], who: '男', photo: true })]) {
      expect(p).toContain('衣服本身带的袖标、织标、印字和图案照参考图原样保留');
      expect(p).not.toMatch(/不要任何文字、标签、logo|没有任何文字、标签、logo/);
    }
  });
});

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
  it('the plan picks who the SKU images show (10-21): the material\'s photos, or the cast in every colour, one of them or both', () => {
    const images = [{ id: 'M9', kind: '模特实拍', color: '深海蓝', person: '女' }, { id: 'M31', kind: '颜色款图', color: '深海蓝' }];
    const d = { colors: [{ name: '深海蓝', pick: 'M31' }], model: { lead: '女' as const } };
    expect(Object.values(skuPhotos(d, images, false))).toEqual(['M9']);
    expect(skuPhotos({ ...d, skuPeople: '实拍' }, images, false)).not.toEqual({});
    for (const p of ['男', '女', '男女'] as const) expect(skuPhotos({ ...d, skuPeople: p }, images, false)).toEqual({});
    const at = (id: string, skuPeople: SkuPeople, model: Model = { lead: '女' }) => { const s = stored(master(id)); return new Map(planJobs({ ...s, photos: {}, draft: { ...defaultDraft(DEMO_MATERIAL, master(id)), extra: [], model, skuPeople } }, master(id), 1).map(j => [j.slot, j])); };
    expect(at('M1', '男').get('skumodel:M31')).toMatchObject({ input: { kind: 'skuModel', who: '男' }, depends: ['product:M31', 'cast'] });
    expect(at('M1', '女').get('skumodel:M31')?.input).not.toHaveProperty('who');
    expect(at('M1', '男女').get('skumodel:M31')).toMatchObject({ input: { kind: 'skuModel', pair: true } });
    expect(at('M4', '男').get('skumodel:M31')?.input).toMatchObject({ who: '男' });
    expect(at('M4', '女').get('skumodel:M31')?.input).not.toHaveProperty('pair');
    expect(at('M1', '男', { lead: '女', photos: { 女: 'M9' } }).get('skumodel:M31')?.depends).toEqual(['product:M31', 'cast:男']);
  });
  it('the chest LOGO is about a palm wide, not 「小小的」 (10-21)', () => {
    for (const line of Object.values(LOGO_LINE)) { expect(line).toContain('宽约 8–10 厘米'); expect(line).not.toContain('小小的'); }
  });
  const plan = (id: string, scene?: { place: string; sell: string; act?: number; look?: number }): StoredPlan => ({ ...stored(master(id)), draft: { ...stored(master(id)).draft, extra: [], ...(scene ? { scene } : {}) } });
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
    expect(coverOf(plan('M3', { place: '工地', sell: '防水' }).draft, master('M3'))).toMatchObject({ bg: expect.stringContaining('下着小雨的工地'), person: expect.stringContaining('水珠') });
    expect(coverOf(plan('M4', { place: '工地', sell: '防水' }).draft, master('M4'))).toBeNull();
    expect(coverOf(plan('M1', { place: '登山', sell: '防水' }).draft, master('M1'))).toBeNull();
  });
  it('the cover takes the act and look the plan picked; 暗黑科技 only low-key looks; its prompt keeps the sample\'s pose and light out', () => {
    const at = (m: string, scene: { place: string; sell: string; act?: number; look?: number }) => coverOf(plan(m, scene).draft, master(m))!;
    const looks = new Set([0, 1, 2].map(look => at('M1', { place: '4S店', sell: '防水', act: look, look }).bg));
    expect(looks.size).toBe(3);
    expect(at('M1', { place: '4S店', sell: '防水', act: 1, look: 0 }).person).toContain('车钥匙');
    for (const look of [0, 1, 2, 3]) expect(at('M2', { place: '汽修', sell: '耐磨', look }).bg).toMatch(/偏暗|压暗|暗灰/);
    const stored = plan('M1', { place: '4S店', sell: '防水', act: 2, look: 1 });
    const c = contentOf(stored, { kind: 'main', index: 0, ratio: 'square', n: 1, total: 5, skus: [], colors: [], words: { title: '拒水', sub: '', tags: [], cells: [] } }, 'square:1', master('M1'), '');
    expect(c.scene).toContain('不要 CG 渲染感');
    const prompt = specPrompt({ master: 'M1', task: '首图', taskLabel: '首图', n: 1, total: 5, spec: SPECS.M1.首图!, garment: [], logo: null, refs: { garment: [{ name: '黑色' }], cast: 2, sample: 3 },
      fill: { title: '拒水', sub: '', tags: [], facts: [], cells: [], color: '黑色', colors: [], all: [], light: false, who: '参考图2里的男生', badge: '', act: c.act, scene: c.scene } });
    expect(prompt).toContain('人物的姿势、手的动作和机位不照参考图3');
    expect(prompt).toContain('背景的颜色、光线和地点都不照参考图3');
    expect(prompt).toContain('拒水');
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
  it('the chest shows the LOGO the plan chose; several colours are photographed together where the set is', () => {
    const t = master('M2').templates.收口.square;
    const prompt = mainPrompt({ ratio: 'square', task: '收口', template: t, layout: master('M2'), content: { ...content, title: '团体定制 2色可选' }, used: colors, all: colors, garment: ['连帽'], lead: '男', fromSku: true, cast: 3, logo: '衣服胸口左侧印一个小小的白色「LOGO」字样' });
    expect(prompt).toContain('胸口左侧印一个小小的白色「LOGO」');
    expect(prompt).toContain(`实景合影，${DEFAULT_PLACE}`);
    expect(prompt).not.toContain('棚拍底');
    const there = mainPrompt({ ratio: 'square', task: '收口', template: t, layout: master('M2'), content: { ...content, title: '团体定制 2色可选' }, used: colors, all: colors, garment: ['连帽'], lead: '男', fromSku: true, cast: 3, logo: null, place: '高山草甸步道' });
    expect(there).toContain('实景合影，高山草甸步道');
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

describe('a group photo for two colours (10-15)', () => {
  const written = JSON.stringify({ product: { name: '', garment: ['连帽'] }, scenes: [], sku: { tag: '', fabric: '' } });
  it('gives each colour its own key on the same photo, and says which garment on it to take', () => {
    const d = defaultDraft(DEMO_MATERIAL, commute), group = d.colors[0].pick!;
    const draft = { ...d, colors: d.colors.map((c, k) => k === 1 ? { ...c, pick: group } : c) };
    const plan = buildPlan(written, { draft, images: [{ label: group, assetId: 'a1' }], direct: [], sorted: [{ id: group, person: '多人' }], model: 'm' });
    const [first, second] = [plan.colors.find(c => c.name === draft.colors[0].name)!, plan.colors.find(c => c.name === draft.colors[1].name)!];
    expect([first.sku, second.sku]).toEqual([group, `${group}-2`]);
    expect(plan.images).toContainEqual({ label: `${group}-2`, assetId: 'a1' });
    expect(plan.sourceSelections).toMatchObject({ [group]: first.name, [`${group}-2`]: second.name });
    const products = planJobs(plan, commute, 1).filter(j => j.slot.startsWith('product:')).map(j => j.slot);
    expect(new Set(products).size).toBe(products.length);
    expect(products).toContain(`product:${group}-2`);
  });
  it('keeps the place the writing step chose for the SKU models and the closer', () => {
    const draft = defaultDraft(DEMO_MATERIAL, commute);
    const there = JSON.stringify({ product: { name: '', garment: ['立领'] }, scenes: [], sku: { tag: '', fabric: '' }, place: ' 高山草甸步道，远处雪山 ' });
    expect(buildPlan(there, { draft, images: [], direct: [], model: 'm' }).place).toBe('高山草甸步道，远处雪山');
    expect(buildPlan(written, { draft, images: [], direct: [], model: 'm' }).place).toBeUndefined();
  });
  it('a plan without group photos is as before', () => {
    const draft = defaultDraft(DEMO_MATERIAL, commute);
    const plan = buildPlan(written, { draft, images: [], direct: [], model: 'm' });
    expect(plan.colors.map(c => c.sku).sort()).toEqual(draft.colors.map(c => c.pick!).sort());
    expect(plan.sourceSelections).toBeUndefined();
  });
});

describe('close-up cards (10-15)', () => {
  const s = stored(), d = s.draft, id = (text: string) => d.points.find(p => p.text === text)!.id;
  const i = d.slots.findIndex(x => x.task === '细节');
  const input = (title: string) => ({ kind: 'main' as const, ratio: 'square' as const, index: i, n: 2, total: 5, skus: ['M30'], colors: ['落霞橙'],
    words: { title, sub: '', tags: [], cells: [{ point: id('利落立领'), proof: 'part', caption: '利落立领' }, { point: id('双侧拉链口袋'), proof: 'part', caption: '双侧拉链口袋' }, { point: id('贴腕袖口'), proof: 'part', caption: '贴腕袖口' }] } });
  it('draws the card of the part the heading names first', () => {
    expect(contentOf(s, input('口袋装得下'), 'square:2', commute, '').cells.map(c => c.text)).toEqual(['双侧拉链口袋', '利落立领', '贴腕袖口']);
    expect(contentOf(s, input('细节经得起看'), 'square:2', commute, '').cells.map(c => c.text)).toEqual(['利落立领', '双侧拉链口袋', '贴腕袖口']);
  });
  it('a close-up goes with the material\'s photo of its part, and without one is an icon and its words', () => {
    const cells = contentOf(s, input('细节经得起看'), 'square:2', commute, '').cells;
    expect(cells[0]).toMatchObject({ photo: 'M40', icon: false });
    expect(cells[1]).toMatchObject({ photo: 'M42' });
    expect(cells[2]).toMatchObject({ icon: true });
    expect(cells[2].photo).toBeUndefined();
  });
});

describe('the closer and the SKU models (10-16)', () => {
  const six = ['落霞橙', '爱马仕橙', '未来白', '北欧蓝', '石苔灰', '黑色'];
  it('gives every place in the group its colour, the main colour in the middle of the front row', () => {
    const line = crowdLine(six.map(name => ({ name })), '参考图7');
    expect(line).toContain('前排从左到右「爱马仕橙」「落霞橙」「未来白」，后排从左到右「北欧蓝」「石苔灰」「黑色」');
    expect(line).toContain('6 种颜色各出现一次');
    expect(line).toContain('参考图7里的男生和女生各出现一次');
    expect(line).not.toContain('排成一排');
  });
  it('gives the others besides the cast faces of their own, and keeps every hand in the picture (10-19)', () => {
    const line = crowdLine(six.map(name => ({ name })), '参考图7');
    // Six people: the cast's two and four others, men and women in turn, no two alike.
    const others = [...line.matchAll(/一位([^；]+?)的(男|女)生，([^；]+)/g)];
    expect(others.map(m => m[2])).toEqual(['男', '女', '男', '女']);
    expect(new Set(others.map(m => m[3])).size).toBe(4);
    expect(line).toContain('同一张图里不能出现两张相同的脸');
    expect(line).not.toContain('举手');
    expect(line).toContain('不把手举过头顶');
    // Another product gets another team; two colours still make four people, two of them others.
    const looks = (l: string) => [...l.matchAll(/一位([^；]+)/g)].map(m => m[1]).join('|');
    const products = [six, ['藏青', '卡其', '军绿', '酒红', '燕麦', '石墨灰'], ['曜石黑', '阳光橙', '深咖色', '灰绿色', '米白色'], ['黑拼白', '骑士黑', '冰雾粉', '卡其色'], ['银灰', '岩壳绿', '红色', '青灰'], ['黑色', '乌梅紫', '深咖色', '黑白']];
    expect(new Set(products.map(p => looks(crowdLine(p.map(name => ({ name })), '参考图7')))).size).toBeGreaterThanOrEqual(3);
    expect([...crowdLine([{ name: '黑色' }, { name: '藏青' }], '定妆照').matchAll(/一位/g)]).toHaveLength(2);
    expect(crowdLine([{ name: '北欧蓝', hex: '#1f2a44' }, { name: '黑色', hex: '#151515' }, { name: '白色' }], '定妆照')).toContain('从左到右「黑色」（#151515）「北欧蓝」（#1f2a44）「白色」');
    expect(crowdLine([{ name: '黑色' }, { name: '藏青' }], '定妆照')).toContain('前排从左到右「黑色」「藏青」，后排从左到右「黑色」「藏青」');
    expect(crowdLine([{ name: '黑色' }, { name: '藏青' }, { name: '白色' }], '定妆照')).toContain('从左到右「藏青」「黑色」「白色」');
  });
  it('the masters\' closers are shot at the set\'s place, the sample lending only its band', () => {
    const fill = { title: '团体定制 · 6色可选', sub: '宽松', tags: [], facts: [], cells: [], color: six[0], colors: six.map(name => ({ name, hex: '#000' })), all: six.map(name => ({ name, hex: '#000' })), light: false, who: '', badge: '', castRef: 7, place: '高山草甸步道' };
    for (const master of ['M1', 'M2', 'M3', 'M4']) {
      const spec = SPECS[master].收口!;
      const prompt = specPrompt({ master, task: '收口', taskLabel: '收口', n: 5, total: 5, spec, fill, garment: ['立领'], logo: null, refs: { garment: fill.colors, cast: 7, sample: 8 } });
      expect(prompt).toContain('实景合影：高山草甸步道');
      expect(prompt).toContain('站位和姿势不照示例图');
      expect(prompt).not.toContain('没有户外场景');
    }
    expect(SPECS.M1.收口!.background({ ...fill, place: undefined })).toContain(DEFAULT_PLACE);
  });
  it('with the shop\'s LOGO in the corner, the corner is kept empty and the customer\'s LOGO stays on the chest only', () => {
    const fill = { title: '团体定制 · 6色可选', sub: '', tags: [], facts: [], cells: [], color: six[0], colors: six.map(name => ({ name, hex: '#000' })), all: six.map(name => ({ name, hex: '#000' })), light: false, who: '', badge: '', castRef: 7 };
    const closer = (corner: boolean) => specPrompt({ master: 'M1', task: '收口', taskLabel: '收口', n: 5, total: 5, spec: SPECS.M1.收口!, fill, garment: ['立领'], logo: '印客户 LOGO', refs: { garment: fill.colors, cast: 7, logo: 8, sample: 9 }, corner });
    expect(closer(false)).toContain('左上角放客户的 LOGO'); expect(closer(false)).toContain('只用来印在衣服胸口和放在左上角');
    expect(closer(true)).not.toContain('左上角放客户的 LOGO'); expect(closer(true)).toContain('只用来印在衣服胸口。');
    expect(closer(true)).toContain('左0% 上0% 宽26% 高13%：左上角空位，之后要贴店铺 LOGO');
    const m4 = MASTERS.find(l => l.id === 'M4')!, one = [{ name: '落霞橙', hex: '#d98a1c' }];
    expect(mainPrompt({ ratio: 'square', task: '细节', template: m4.templates.细节.square, layout: m4, content: { title: '细节', sub: '', tags: [], cells: [], scene: '' }, used: one, all: one, garment: ['连帽'], lead: '男', fromSku: false, cast: null, corner: true }))
      .toContain('左上角空位，之后要贴店铺 LOGO');
    expect(relayoutPrompt(false, true)).toContain('参考图1左上角留着一块空位'); expect(relayoutPrompt(false)).not.toContain('空位');
    expect(redrawPrompt({ ratio: 'portrait', ask: '背景换亮', reference: false, corner: true })).toContain('宽26% 高10% 只有背景');
  });
  it('a SKU model stands where the set is shot, the pose turning with the colour', () => {
    const at = (pose: number, place?: string) => skuModelPrompt({ color: '北欧蓝', garment: ['立领'], lead: '男', who: 'lead', halves: false, logo: null, place, pose });
    expect(at(0, '高山草甸步道')).toContain('场景实拍：高山草甸步道');
    expect(at(0)).toContain(`场景实拍：${DEFAULT_PLACE}`);
    expect(at(0)).not.toContain('纯浅灰色无缝背景');
    expect(at(0)).not.toBe(at(1));
    expect(at(0)).toContain('从头顶拍到膝盖');
  });
});
