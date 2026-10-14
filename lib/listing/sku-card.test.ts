import { describe, expect, it } from 'vitest';
import { colorRow, modelPhotoFor, skuCardText } from './sku-card';

const point = (type: string, text: string, note = '', on = true) => ({ type, text, note, on, source: '素材' as const }) as Parameters<typeof skuCardText>[0]['points'][number];

describe('skuCardText', () => {
  it('takes the style number and the fabric, and splits the first function into the card', () => {
    const t = skuCardText({ name: 'M12#轻量化连帽单冲', category: 'workwear', points: [
      point('功能', '防水、透气、耐磨、轻便', '穿着舒适 吸汗透气'), point('面料', '90%锦纶 10%氨纶'), point('做工', 'YKK品牌拉链', '大品牌更有保障'), point('功能', '防风保暖'),
    ] });
    expect(t.title).toEqual(['高端定制', '支持印绣']);
    expect(t.rows.map(r => [r.label, r.value])).toEqual([['STYLE NO./款号', 'M12'], ['FABRIC/面料', '90%锦纶 10%氨纶']]);
    expect(t.feature).toEqual({ title: '防水透气', sub: '穿着舒适 吸汗透气', icons: [{ icon: 'water', label: '防水' }, { icon: 'breathe', label: '透气' }, { icon: 'wear', label: '耐磨' }] });
  });
  it('without a style number or a fabric, the next things the material has take their rows', () => {
    const t = skuCardText({ name: '552挂拍新图', category: 'workwear', points: [point('做工', 'YKK品牌拉链', '大品牌更有保障'), point('人群场景', '登山露营'), point('颜色款式', '立体有型 简约时尚')] });
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
