import { describe, expect, it } from 'vitest';
import { applyEdit, editFor, editOf, rowIcon, skuTextProblems, type CardWords } from './sku-text';

const own: CardWords = {
  kicker: 'PREMIUM QUALITY', title: ['品质做工', '舒适百搭'], linerName: '羽绒内胆',
  rows: [{ label: 'STYLE NO./货号', value: '8826', sub: '', icon: 'style' }, { label: 'COLOR/颜色', value: '藏青', sub: '经典配色 百搭耐看', icon: 'color' }],
  feature: { title: '石墨烯蓄热恒温', sub: '轻暖透气', icons: [{ icon: 'water', label: '防泼水' }] }, pill: { text: '男女同款', place: 'title' },
};

describe('改 SKU 图文字 (11-01)', () => {
  it('starts the form from the words the image prints, the colour row marked', () => {
    const e = editOf(own);
    expect(e).toMatchObject({ badge: '男女同款', title: ['品质做工', '舒适百搭'], liner: '羽绒内胆', feature: { icons: ['防泼水'] } });
    expect(e.rows[1]).toEqual({ label: 'COLOR/颜色', value: '藏青', sub: '经典配色 百搭耐看', color: true });
  });
  it("prints what was written: a row emptied goes, the colour row follows each image's colour, icons follow their words", () => {
    const e = { ...editOf(own), title: ['冬季新款', ''] as [string, string], rows: [{ label: '款号', value: 'A-8826', sub: '' }, { label: '面料', value: '', sub: '' }, { label: '颜色', value: '随便', sub: '', color: true }] };
    const red = applyEdit({ ...own, rows: [own.rows[0], { ...own.rows[1], value: '朱雀红' }] }, e, 'title');
    expect(red.title).toEqual(['冬季新款']);
    expect(red.rows.map(r => [r.label, r.value, r.icon])).toEqual([['款号', 'A-8826', 'style'], ['颜色', '朱雀红', 'color']]);
    expect(applyEdit(own, { ...e, feature: { title: '', sub: '', icons: [] } }, 'title').feature).toBeNull();
    expect(applyEdit(own, { ...e, feature: { title: '三防面料', sub: '', icons: ['透气'] } }, 'title').feature?.icons).toEqual([{ icon: 'breathe', label: '透气' }]);
  });
  it('keeps the pill where the image had it; a new one goes where the caller says', () => {
    expect(applyEdit(own, { ...editOf(own), badge: '新品' }, 'right').pill).toEqual({ text: '新品', place: 'title' });
    expect(applyEdit({ ...own, pill: null }, { ...editOf(own), badge: '新品' }, 'right').pill).toEqual({ text: '新品', place: 'right' });
    expect(applyEdit(own, { ...editOf(own), badge: ' ' }, 'title').pill).toBeNull();
    expect(applyEdit({ ...own, linerName: undefined }, editOf(own), 'title')).not.toHaveProperty('linerName');
  });
  it('says which word is too long, by its place', () => {
    expect(skuTextProblems(editOf(own))).toEqual([]);
    expect(skuTextProblems({ ...editOf(own), title: ['一二三四五六七', ''] })).toEqual([{ where: '标题第 1 行', max: 6 }]);
    expect(skuTextProblems({ ...editOf(own), rows: [{ label: '货号', value: '一二三四五六七八九十', sub: '' }] })[0].where).toBe('第 1 行的大字');
  });
  it("an image's own words come before the whole product's", () => {
    const all = editOf(own), mine = { ...all, title: ['只改这张', ''] as [string, string] };
    expect(editFor({ all, one: { M1: mine } }, 'M1')).toBe(mine);
    expect(editFor({ all, one: { M1: mine } }, 'M2')).toBe(all);
    expect(editFor(undefined, 'M1')).toBeUndefined();
    expect(rowIcon('外层面料', '双经双纬T800')).toBe('fabric');
  });
});
