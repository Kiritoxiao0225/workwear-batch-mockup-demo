import { describe, expect, it } from 'vitest';
import { colorRow, modelPhotoFor, SKU_AUTO_SET, skuCardRows, skuCardText, skuSetOf, styleNo } from './sku-card';

const point = (type: string, text: string, note = '', on = true) => ({ type, text, note, on, source: '素材' as const }) as Parameters<typeof skuCardText>[0]['points'][number];

describe('skuCardText', () => {
  it('takes the style number and the fabric, and splits the first function into the card', () => {
    const t = skuCardText({ name: 'M12#轻量化连帽单冲', category: 'workwear', points: [
      point('功能', '防水、透气、耐磨、轻便', '穿着舒适 吸汗透气'), point('面料', '90%锦纶 10%氨纶'), point('做工', 'YKK品牌拉链', '大品牌更有保障'), point('功能', '防风保暖'),
    ] });
    expect(t.title).toEqual(['高端定制', '支持印绣']);
    expect(t.rows.map(r => [r.label, r.value])).toEqual([['STYLE NO./货号', 'M12'], ['FABRIC/面料', '90%锦纶 10%氨纶']]);
    expect(t.feature).toEqual({ title: '防水透气', sub: '穿着舒适 吸汗透气', icons: [{ icon: 'water', label: '防水' }, { icon: 'breathe', label: '透气' }, { icon: 'wear', label: '耐磨' }] });
  });
  it('without a style number or a fabric, the next things the material has take their rows', () => {
    const t = skuCardText({ name: '挂拍新图', category: 'workwear', points: [point('做工', 'YKK品牌拉链', '大品牌更有保障'), point('人群场景', '登山露营'), point('颜色款式', '立体有型 简约时尚')] });
    expect(t.rows.map(r => r.label)).toEqual(['FIT/版型', 'DETAIL/工艺']);
    expect(t.rows[1]).toMatchObject({ value: 'YKK品牌拉链', sub: '大品牌更有保障', icon: 'zip' });
    expect(t.feature).toBeNull();
  });
  it('a single function point gives the card its title and the next points its icons; nothing is made up', () => {
    const t = skuCardText({ name: 'x', category: 'workwear', points: [point('功能', '科技锁温'), point('功能', '防风保暖'), point('定位', '冲锋衣定制')] });
    expect(t.rows).toEqual([]);
    expect(t.feature).toEqual({ title: '科技锁温', sub: '', icons: [{ icon: 'wind', label: '防风保暖' }] });
    expect(colorRow('爱马仕橙')).toMatchObject({ label: 'COLOR/颜色', value: '爱马仕橙' });
  });
});

describe('modelPhotoFor', () => {
  const shot = (id: string, color: string, person = '', face = false) => ({ id, kind: '模特实拍', color, person, face });
  it("finds the colour's own photos with a person by the colour read on its chosen image, one person (the lead first) before a pair", () => {
    const images = [{ id: 'M242', kind: '静物', color: '爱马仕橙' }, shot('M58', '爱马仕橙', '女', true), shot('M60', '爱马仕橙', '男'), shot('M62', '爱马仕橙', '男女', true), shot('M98', '北欧蓝', '男女')];
    expect(modelPhotoFor(images, 'M242', '亮橙', '男')).toBe('M60');
    expect(modelPhotoFor(images, 'M242', '亮橙', '女')).toBe('M58');
    expect(modelPhotoFor(images, 'M209', '蓝色')).toBeNull();
  });
  it('a master whose cover has a man and a woman wants them together first', () => {
    const images = [{ id: 'M242', kind: '静物', color: '爱马仕橙' }, shot('M58', '爱马仕橙', '男', true), shot('M62', '爱马仕橙', '男女'), shot('M63', '爱马仕橙', '多人', true)];
    expect(modelPhotoFor(images, 'M242', '爱马仕橙', '男', true)).toBe('M62');
    expect(modelPhotoFor([images[0], images[1]], 'M242', '爱马仕橙', '男', true)).toBe('M58');
  });
  it('a photo labelled a model shot without a person (a hanger shot) is not one', () => {
    expect(modelPhotoFor([shot('M1', '黑色'), shot('M2', '黑色', '')], 'M1', '黑色')).toBeNull();
  });
});

describe('modelPhotoFor and liners', () => {
  it('a model photo of the liner alone is not the colour\'s model photo', () => {
    const images = [{ id: 'M4', kind: '静物', color: '黑色' }, { id: 'M75', kind: '模特实拍', color: '黑色', person: '男', face: true, role: '内胆' }, { id: 'M80', kind: '模特实拍', color: '黑色', person: '男' }];
    expect(modelPhotoFor(images, 'M4', '黑色', '男')).toBe('M80');
  });
});

describe('the SKU title (10-16)', () => {
  it('has a small English line over it', () => {
    expect(skuCardText({ name: '6610#立领薄款', category: 'workwear', points: [] })).toMatchObject({ kicker: 'PREMIUM CUSTOM', title: ['高端定制', '支持印绣'] });
    expect(skuCardText({ name: 'T恤', category: 'generic', points: [] }).kicker).toBe('PREMIUM QUALITY');
  });
});

describe('the card never cuts words (10-19)', () => {
  const lead = (text: string, note = '') => point('功能', text, note);
  it('keeps whole the words the 75 sets showed cut: icons, titles and notes', () => {
    const t = skuCardText({ name: '7716一体超柔石墨烯冲锋衣', category: 'workwear', points: [
      lead('IP4.0防水层', '轻拭雨水自动滑落'), lead('双重防风'), lead('黑金石墨烯 呵护肩颈'), lead('防油污涂层'), lead('可拆卸摇粒内胆'),
    ] });
    expect(t.feature?.title).toBe('IP4.0防水层');
    expect(t.feature?.icons.map(i => i.label)).toEqual(['双重防风', '黑金石墨烯', '防油污涂层']);
    const units = skuCardText({ name: '318款单层冲锋衣', category: 'workwear', points: [lead('防水指数4000+MMH₂O', '滴水成珠'), lead('透气透湿', '透湿指数6500⁺ G/M²·24H')] });
    expect(units.feature).toMatchObject({ title: '防水指数4000+MMH₂O', sub: '滴水成珠' });
    expect(skuCardText({ name: 'x', category: 'workwear', points: [lead('滴水成珠', '防水指数40000⁺ MMH₂O')] }).feature?.sub).toBe('防水指数40000⁺ MMH₂O');
  });
  it('a word too long for its place gives way to the next one, and a bare figure is no icon', () => {
    const t = skuCardText({ name: '6607#连帽薄款', category: 'workwear', points: [
      lead('滴水成珠'), lead('透气透湿'), lead('40000+ MMH₂O'), lead('6000+ G/㎡·24H'), lead('防风'),
      point('面料', '无氟面料是一种环保型纺织材料', '不含氟系化合物'), point('面料', '100%聚酯纤维'),
    ] });
    expect(t.feature?.icons.map(i => i.label)).toEqual(['透气透湿', '防风']);
    expect(t.rows[1]).toMatchObject({ label: 'FABRIC/面料', value: '100%聚酯纤维' });
    // A long note is left off rather than cut.
    expect(skuCardText({ name: 'x', category: 'workwear', points: [point('面料', '三防面料', '轻拭雨水自动滑落，易清洁、易打理，不怕油污')] }).rows[0].sub).toBe('');
  });
  it('the fabric row is never the down filling, and two-colour words go only on a two-colour colour', () => {
    const points = [point('面料', '纯净白鸭绒 90%', '触手可及的温暖'), point('面料', '石墨烯面料'), point('颜色款式', '撞色设计剪裁', '可商务可休闲'), point('做工', '魔术贴袖口', '收紧袖口防进风')];
    expect(skuCardText({ name: 'x', category: 'workwear', points, color: '黑色' }).rows.map(r => r.value)).toEqual(['石墨烯面料', '魔术贴袖口']);
    expect(skuCardText({ name: 'x', category: 'workwear', points, color: '红拼黑' }).rows.map(r => r.value)).toEqual(['石墨烯面料', '撞色设计剪裁']);
    expect(colorRow('冰川蓝拼雾霾灰').value).toBe('冰川蓝拼雾霾灰');
  });
});

describe('modelPhotoFor and the way the model faces (10-19)', () => {
  it('takes the photo facing the camera before one turned away', () => {
    const images = [{ id: 'M414', kind: '静物', color: '乌梅紫' }, { id: 'M1', kind: '模特实拍', color: '乌梅紫', person: '男', face: true, facing: '侧身' }, { id: 'M2', kind: '模特实拍', color: '乌梅紫', person: '男', face: true, facing: '正对' }];
    expect(modelPhotoFor(images, 'M414', '乌梅紫', '男')).toBe('M2');
  });
});

describe('icons say a point\'s short name (10-19)', () => {
  it('a long point on an icon says its short name, a point without one its first words', () => {
    const lead = { ...point('功能', '高防水透气膜', '') }, long = { ...point('功能', '可呼吸冲锋衣透气面料'), short: '透气面料' };
    expect(skuCardText({ name: 'x', category: 'workwear', points: [lead, point('功能', '严密防风'), long, point('功能', '持续保暖')] }).feature?.icons.map(i => i.label)).toEqual(['严密防风', '透气面料', '持续保暖']);
    expect(skuCardText({ name: 'x', category: 'workwear', points: [lead, point('功能', '严密防风'), { ...long, short: undefined }] }).feature?.icons.map(i => i.label)).toEqual(['严密防风', '可呼吸冲锋衣透气面料']);
  });
});

describe('SKU 图字段组合 and 货号 (11-01)', () => {
  const points = [point('面料', '100%聚酯纤维'), point('颜色款式', '经典百搭款'), point('做工', 'YKK品牌拉链'), point('人群场景', '登山露营')];
  const color = colorRow('藏青');
  it('reads the 货号 at the front of the name, with or without 「#」', () => {
    expect(styleNo('8826款羽绒一体')).toBe('8826');
    expect(styleNo('6608#立领薄款')).toBe('6608');
    expect(styleNo('LD1425-黑')).toBe('LD1425');
    expect(styleNo('XHM24 卡车帽')).toBe('XHM24');
    expect(styleNo('羽绒一体冲锋衣')).toBeNull();
  });
  it('自动 is the rule from before plus the 货号 without 「#」: two rows, then the colour', () => {
    const rows = skuCardRows({ name: '8826款羽绒一体', category: 'workwear', points }, SKU_AUTO_SET, color);
    expect(rows.map(r => [r.label, r.value])).toEqual([['STYLE NO./货号', '8826'], ['FABRIC/面料', '100%聚酯纤维'], ['COLOR/颜色', '藏青']]);
  });
  it("prints a combo's fields in its order, the colour where it is put, and leaves out a field with no words", () => {
    const set = { id: 'f00000001', name: '场景', fields: ['scene', 'color', 'fit'] as const };
    expect(skuCardRows({ name: 'x', category: 'workwear', points }, { ...set, fields: [...set.fields] }, color).map(r => r.value)).toEqual(['登山露营', '藏青', '经典百搭款']);
    const noStyle = { id: 'f00000002', name: '货号', fields: ['style' as const, 'detail' as const] };
    expect(skuCardRows({ name: '冲锋衣', category: 'workwear', points }, noStyle, color).map(r => r.value)).toEqual(['YKK品牌拉链']);
  });
  it("puts the plan's typed words first, and calls a lined jacket's fabric the shell's", () => {
    const set = { id: 'f00000003', name: '货号面料', fields: ['style' as const, 'fabric' as const, 'color' as const] };
    const rows = skuCardRows({ name: '8826款羽绒一体', category: 'workwear', points, words: { style: '8826A', fabric: '' }, outer: true }, set, color);
    expect(rows.map(r => [r.label, r.value])).toEqual([['STYLE NO./货号', '8826A'], ['FABRIC/外层面料', '100%聚酯纤维'], ['COLOR/颜色', '藏青']]);
  });
  it("uses the product's pick while the shop has it, else the shop's default, else 自动", () => {
    const shop = { sets: [{ id: 'f00000001', name: 'A', fields: ['style' as const] }, { id: 'f00000002', name: 'B', fields: ['fit' as const] }], default: 'f00000002' };
    expect(skuSetOf(shop, 'f00000001').name).toBe('A');
    expect(skuSetOf(shop, 'gone').name).toBe('B');
    expect(skuSetOf(shop).name).toBe('B');
    expect(skuSetOf({ sets: [], default: 'gone' }).id).toBe('auto');
    expect(skuSetOf(undefined, 'auto').id).toBe('auto');
  });
});
