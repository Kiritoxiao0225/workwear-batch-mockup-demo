import { describe, expect, it } from 'vitest';
import { itemPhoto, itemReference, linerByColor, linerFor, mainLiner, skuItems, linerThumbs, type DraftVersion } from './sku-versions';

const colors = [{ name: '乌梅紫', sku: 'M1' }, { name: '幻影黑', sku: 'M2' }];
const v = (key: string, kind: DraftVersion['kind'], inner: DraftVersion['inner'], cs: string[], on = true): DraftVersion => ({ key, kind, inner, colors: cs, on });
// 1888 (10-21): both shells alone and over the down liner, purple over the fleece, the beige fleece alone.
const versions = [v('v1', '单外壳', '', ['乌梅紫', '幻影黑']), v('v2', '外壳加内胆', '羽绒', ['乌梅紫', '幻影黑']), v('v3', '外壳加内胆', '摇粒绒', ['乌梅紫']), v('v4', '单内胆', '摇粒绒', ['米色'])];

describe('skuItems: one SKU image per colour and version (10-22)', () => {
  it('without versions, one per colour as before', () => {
    expect(skuItems({}, colors).map(i => [i.key, i.label])).toEqual([['M1', '乌梅紫'], ['M2', '幻影黑']]);
  });
  it('each colour keeps its own key for its shell alone; the liners get their own; a liner alone goes by its colour', () => {
    expect(skuItems({ versions }, colors).map(i => [i.key, i.label])).toEqual([
      ['M1', '乌梅紫 · 单外壳'], ['M1~v2', '乌梅紫 · 外壳 + 羽绒内胆'], ['M1~v3', '乌梅紫 · 外壳 + 摇粒绒内胆'],
      ['M2', '幻影黑 · 单外壳'], ['M2~v2', '幻影黑 · 外壳 + 羽绒内胆'],
      ['~v4~0', '米色 · 单穿摇粒绒内胆'],
    ]);
  });
  it('with 单外壳 unticked, a colour\'s own key is its first liner, so the main images of several colours still have it', () => {
    const items = skuItems({ versions: versions.map(x => x.key === 'v1' ? { ...x, on: false } : x) }, colors);
    expect(items.filter(i => i.color === 'M1').map(i => [i.key, i.label])).toEqual([['M1', '乌梅紫 · 外壳 + 羽绒内胆'], ['M1~v3', '乌梅紫 · 外壳 + 摇粒绒内胆']]);
  });
});

describe('the material\'s own photo of an item, and what a drawn one is drawn from', () => {
  const images = [
    { id: 'P1', kind: '模特实拍', role: '主体', color: '乌梅紫', person: '女', face: true },
    { id: 'P2', kind: '模特实拍', role: '主体', color: '乌梅紫', inner: '羽绒', innerColor: '黑色', person: '女', face: true },
    { id: 'P3', kind: '模特实拍', role: '内胆', color: '米色', inner: '摇粒绒', innerColor: '米色', person: '女' },
    { id: 'P4', kind: '静物', role: '主体', color: '幻影黑', inner: '羽绒', innerColor: '黑色' },
  ];
  const items = skuItems({ versions }, colors), at = (key: string) => items.find(i => i.key === key)!;
  it('a photo of exactly that colour and version, worn by one person', () => {
    expect(['M1', 'M1~v2', '~v4~0', 'M2~v2', 'M1~v3'].map(k => itemPhoto(images, at(k), '女', false))).toEqual(['P1', 'P2', 'P3', null, null]);
  });
  it('a drawn one from any image of it (a still life counts); a colour only ticked by the user, from the version in another colour', () => {
    expect(itemReference(images, at('M2~v2'))).toBe('P4');
    expect(itemReference(images, at('M1~v3'))).toBeNull();
    const ticked = skuItems({ versions: [v('v2', '外壳加内胆', '羽绒', ['乌梅紫', '幻影黑', '军绿'])] }, [...colors, { name: '军绿', sku: 'M3' }]);
    expect(itemReference(images, ticked.find(i => i.key === 'M3')!)).toBe('P2');
  });
});

describe('the liner each shell colour wears (10-22)', () => {
  const images = [
    { id: 'F1', kind: '模特实拍', role: '主体', color: '乌梅紫', inner: '摇粒绒', innerColor: '米色', person: '女' },
    { id: 'F2', kind: '模特实拍', role: '内胆', color: '黑色', inner: '摇粒绒', innerColor: '黑色', person: '女' },
  ];
  const fleece = () => v('v3', '外壳加内胆', '摇粒绒', ['乌梅紫', '幻影黑']);
  it('the material\'s where it shows one; a colour it never shows over the liner is zipped up, not given another colour\'s', () => {
    const ver = fleece();
    expect([linerFor(images, ver, '乌梅紫'), linerFor(images, ver, '幻影黑')]).toEqual(['米色', '']);
    const items = skuItems({ versions: [ver] }, colors), black = items.find(i => i.name === '幻影黑')!;
    expect(itemReference(images, black, '')).toBeNull();
  });
  it('the user\'s choice: drawn from that liner\'s own photo, and a photo in another liner is not used as it is', () => {
    const ver = { ...fleece(), liners: { 幻影黑: '黑色', 乌梅紫: '黑色' } };
    const items = skuItems({ versions: [ver] }, colors), at = (n: string) => items.find(i => i.name === n)!;
    expect(itemReference(images, at('幻影黑'), linerFor(images, ver, '幻影黑'))).toBe('F2');
    expect(itemPhoto(images, at('乌梅紫'), '女', false)).toBeNull();
  });
});

describe('mainLiner: the main images wear each colour\'s own liner (10-25)', () => {
  // 6609 as sorted: each shell over the fleece in its own colour, 安哥拉红 over black down; 白色 also added by hand over black down.
  const shell = (id: string, color: string, inner: string, innerColor: string) => ({ id, kind: '模特实拍', role: '主体', color, inner, innerColor, person: '女' });
  const images = [
    shell('A1', '白色', '摇粒绒', '浅灰色'), shell('A2', '白色', '摇粒绒', '浅灰色'), shell('A3', '白+咖啡', '摇粒绒', '咖啡色'), shell('A4', '白+黑', '摇粒绒', '黑色'),
    shell('A5', '翠绿', '摇粒绒', '黑色'), shell('A6', '安哥拉红', '羽绒', '黑色'), shell('A7', '安哥拉红', '羽绒', '黑色'),
    { id: 'L1', kind: '静物', role: '内胆', color: '黑色', inner: '羽绒', innerColor: '黑色' },
  ];
  const fleece = v('v2', '外壳加内胆', '摇粒绒', ['白色', '白+咖啡', '白+黑', '翠绿']), down = { ...v('v3', '外壳加内胆', '羽绒', ['安哥拉红', '白色']), liners: { 白色: '黑色' } };
  const d = { wear: { type: '内胆' as const }, versions: [v('v1', '单外壳', '', ['白色', '咖啡']), down, fleece] };
  const pick = (dd: typeof d & { wear: { main?: string } }, c: string) => { const m = mainLiner(images, dd, c); return m && [m.version.inner, m.color, m.ref]; };
  it('each colour over the liner the material shows it in most, from that photo', () => {
    expect(pick(d, '白色')).toEqual(['摇粒绒', '浅灰色', 'A1']);
    expect(pick(d, '白+咖啡')).toEqual(['摇粒绒', '咖啡色', 'A3']);
    expect(pick(d, '白+黑')).toEqual(['摇粒绒', '黑色', 'A4']);
    expect(pick(d, '安哥拉红')).toEqual(['羽绒', '黑色', 'A6']);
  });
  it('the user\'s pick first where the colour has it; a colour with no liner has none (zipped up)', () => {
    expect(pick({ ...d, wear: { type: '内胆', main: 'v3' } }, '白色')).toEqual(['羽绒', '黑色', 'A6']); // the liner from another shell's photo of it, as its SKU image
    expect(pick({ ...d, wear: { type: '内胆', main: 'v3' } }, '翠绿')).toEqual(['摇粒绒', '黑色', 'A5']);
    expect(pick(d, '咖啡')).toBeNull();
  });
  it('applies only with a ticked version over a liner', () => {
    expect(linerByColor(d)).toBe(true);
    expect(linerByColor({ ...d, versions: d.versions.map(x => ({ ...x, on: x.kind === '单外壳' })) })).toBe(false);
    expect(linerByColor({ ...d, wear: { type: '薄款' as never } })).toBe(false);
  });
});

describe('the liners on the SKU cards\' thumbnails, each onto white once (11-04)', () => {
  // 8828: the red soft liner's only photo is a shop rack (read as a still life); the black down one has a white still life.
  const images = [
    { id: 'R1', kind: '静物', role: '内胆', color: '红色', inner: '软壳', innerColor: '红色', person: '' },
    { id: 'D1', kind: '静物', role: '内胆', color: '黑色', inner: '羽绒', innerColor: '黑色', person: '' },
    { id: 'D2', kind: '模特实拍', role: '内胆', color: '黑色', inner: '羽绒', innerColor: '黑色', person: '女' },
    { id: 'S1', kind: '模特实拍', role: '内胆', color: '黑色', inner: '软壳', innerColor: '黑色', person: '女' },
  ];
  const reds = [{ name: '朱雀红', sku: 'R' }, { name: '藏青', sku: 'N' }];
  const ver = [v('v1', '单外壳', '', ['朱雀红', '藏青']), { ...v('v2', '外壳加内胆', '软壳', ['朱雀红', '藏青']), liners: { 朱雀红: '红色', 藏青: '蓝色' } },
    { ...v('v3', '外壳加内胆', '羽绒', ['朱雀红', '藏青']), liners: { 朱雀红: '黑色', 藏青: '黑色' } }];
  it('one per liner and colour, shared by every card that shows it; same-colour photos first, a still life marked', () => {
    const t = linerThumbs(images, { versions: ver }, reds);
    expect(t.items).toEqual({ 'R~v2': '软壳~红色', 'R~v3': '羽绒~黑色', 'N~v2': '软壳~蓝色', 'N~v3': '羽绒~黑色' });
    expect(t.photos['羽绒~黑色']).toEqual([{ label: 'D1', same: true, still: true }, { label: 'D2', same: true, still: false }]);
    expect(t.photos['软壳~红色']).toEqual([{ label: 'R1', same: true, still: true }]);
    // No photo in its colour: the best of another colour, drawn in its own.
    expect(t.photos['软壳~蓝色']).toEqual([{ label: 'R1', same: false, still: true }]);
    expect(t.items).not.toHaveProperty('R');
  });
  it('a liner zipped up, or with no photo at all, has none', () => {
    const zipped = [{ ...ver[1], liners: { 朱雀红: '', 藏青: '' } }];
    expect(linerThumbs(images, { versions: zipped }, reds)).toEqual({ photos: {}, items: {} });
    expect(linerThumbs([], { versions: ver }, reds)).toEqual({ photos: {}, items: {} });
  });
});
