import { describe, expect, it } from 'vitest';
import { shapeOf } from './layouts';
import { assignColors, draftImages, overLimit, planSlots, priceLines, slotsFor, syncCloser, thinOf, type Draft, type Point } from './plan';

// M12's selling points in the order the model ranked them.
const p = (type: string, text: string, note = ''): Point => ({ type, text, note, why: '', from: [] });
const M12 = [p('功能', '防水三级以上', '防水指数三级以上'), p('定位', '轻量化连帽冲锋衣'), p('功能', '透气'), p('功能', '耐磨'), p('功能', '抗撕裂'), p('功能', '科技锁温'),
  p('面料', '90%锦纶 10%氨纶'), p('做工', 'YKK品牌拉链', '顺滑耐用 不卡链'), p('实用', '帽围自由调节'), p('实用', '两侧拉链口袋'), p('做工', '内里包边'), p('人群场景', '户外露营')];
const COLORS = [{ name: '落霞橙', hex: '#d98a1c' }, { name: '黑色', hex: '#1d1d1f' }, { name: '北欧蓝', hex: '#24365c' }, { name: '石苔灰', hex: '#b8bbb4' }, { name: '未来白', hex: '#ecebe6' }, { name: '橙色', hex: '#ef5a1c' }];

describe('planSlots', () => {
  it('shares the points out by type so the strong ones are all used', () => {
    const { slots, poster } = planSlots(M12, COLORS.map(c => c.name));
    expect(slots.map(s => [s.role, s.title, ...s.tags])).toEqual([
      ['首图', '轻量化连帽冲锋衣', '防水三级以上', '透气'],
      ['功能', '防水三级以上', '透气', '耐磨'],
      ['功能', '抗撕裂', '科技锁温', '90%锦纶 10%氨纶'],
      ['细节', 'YKK品牌拉链', '帽围自由调节', '两侧拉链口袋'],
      ['收口', '6色可选', '户外露营'],
    ]);
    expect(slots[1].sub).toBe('防水指数三级以上');
    expect(slots[4].sub).toBe('');
    expect(poster).toEqual({ title: '轻量化连帽冲锋衣', sub: '防水三级以上 · 透气' });
  });

  it('with one colour the closer tells who it is for, and few points still fill every image', () => {
    const { slots } = planSlots([p('定位', '立领工作服'), p('做工', '双线走线'), p('人群场景', '工厂车间', '耐脏耐磨')], ['藏青']);
    expect(slots.map(s => s.title)).toEqual(['立领工作服', '双线走线', '', '', '工厂车间']);
    expect(thinOf(slots[2], 2)).toMatch('没有大标题');
    expect(syncCloser({ ...slots[4], title: '6色可选' }, ['藏青', '黑色'])).toMatchObject({ title: '2色可选' });
  });
});

describe('assignColors', () => {
  it('uses the main colour on the cover, light colours for close-ups and no near-black on feature images', () => {
    const { slots } = planSlots(M12, COLORS.map(c => c.name));
    const out = assignColors(slots, COLORS, '落霞橙');
    expect(out.map(s => s.colors.join('+'))).toEqual(['落霞橙', '北欧蓝', '未来白', '石苔灰', '落霞橙+黑色+未来白+石苔灰']);
  });

  it('keeps what the user chose and reuses colours when there are too few', () => {
    const { slots } = planSlots(M12, ['黑色', '落霞橙', '北欧蓝']);
    const three = COLORS.filter(c => ['黑色', '落霞橙', '北欧蓝'].includes(c.name));
    const mine = assignColors(slots.map((s, i) => i === 3 ? { ...s, colors: ['北欧蓝'], manual: true } : s), three, '黑色');
    expect(mine[3]).toMatchObject({ colors: ['北欧蓝'], why: '你选的' });
    expect(mine.slice(1, 4).every(s => s.colors.length === 1)).toBe(true);
    expect(mine[0].colors).toEqual(['黑色']);
  });
});

describe('shapeOf', () => {
  it('measures the two Taobao main-image shapes only', () => {
    expect(shapeOf(800, 800)).toBe('1:1');
    expect(shapeOf(1440, 1920)).toBe('3:4');
    expect(shapeOf(1000, 1792)).toBe('其他');
  });
});

describe('images and price', () => {
  it('counts the cover-only extra set and frees clean still lifes', () => {
    const { slots, poster } = planSlots(M12, ['落霞橙', '黑色']);
    const draft: Draft = { colors: [{ name: '落霞橙', hex: '', pick: 'M1' }, { name: '黑色', hex: '', pick: 'M2' }], main: '落霞橙', parts: [],
      slots: assignColors(slots, COLORS.slice(0, 2), '落霞橙'), poster, layout: 'warm-impact', counts: { square: 3, portrait: 0, poster: 1 }, extra: [{ color: '黑色', layout: '' }] };
    const items = draftImages(draft, new Set(['M1']));
    expect(items.map(i => i.slot)).toEqual(['product:M1', 'product:M2', 'sku:M1', 'sku:M2', 'square:1', 'square:2', 'square:3', 'poster:1', 'square:1+M2', 'poster:1+M2']);
    expect(slotsFor(3)).toEqual([0, 1, 4]);
    expect(priceLines(items, 44, 72).map(l => [l.label, l.count, l.credits])).toEqual([
      ['白底产品图', 1, 0], ['白底产品图', 1, 44], ['SKU 图', 2, 88], ['1:1 主图', 2, 88], ['1:1 主图（多色同框）', 1, 72], ['2:3 海报', 1, 44], ['加一套首图 · 黑色', 2, 88]]);
  });
});

describe('planSlots with more points of one type than its images hold', () => {
  it('never leaves out a stronger point while a weaker one is used', () => {
    // M12 as the model ranked it on 10-06: eight feature and fabric points, then close-up ones.
    const ranked = [p('功能', '防水三级以上'), p('定位', '轻量化连帽单冲'), p('功能', '防水、透气、耐磨、轻便'), p('做工', 'YKK品牌拉链'), p('功能', '户外旅行 防风保暖'), p('面料', '防水透气面料'),
      p('面料', '90%锦纶 10%氨纶'), p('功能', '耐磨 抗撕裂'), p('功能', '内里透气保暖'), p('功能', '科技锁温'), p('实用', '两侧拉链口袋'), p('做工', '时尚连帽 周全防护')];
    const { slots } = planSlots(ranked, ['落霞橙', '黑色']);
    const used = slots.slice(1, 4).flatMap(s => [s.title, ...s.tags]);
    expect(slots.slice(1, 4).map(s => [s.role, s.title])).toEqual([['功能', '防水三级以上'], ['功能', '防水透气面料'], ['细节', 'YKK品牌拉链']]);
    expect(used).toEqual(expect.arrayContaining(['内里透气保暖', '科技锁温']));
    expect(used).not.toContain('两侧拉链口袋');
  });
});

describe('limits', () => {
  it('never fills the closer or the poster with more words than the server accepts', () => {
    const many = ['落霞橙', '北欧蓝', '空间灰', '黑色', '希望绿', '爱马仕橙', '石苔灰', '云朵白', '浅蓝色', '蓝色'];
    const { slots, poster } = planSlots([p('定位', '轻量化连帽单冲'), p('功能', '防水三级以上防风防雨抗皱性强'), p('功能', '舒适透气加倍保暖舒适内里设计')], many);
    expect(slots[4]).toMatchObject({ title: '10色可选', sub: '' });
    expect(overLimit(poster)).toBe('');
    expect(thinOf(slots[4], 4)).not.toMatch('没有小字');
    expect(overLimit({ title: '大标题', sub: '一'.repeat(31) })).toMatch('小字超过 30 个字');
  });
});
