import { describe, expect, it } from 'vitest';
import { coveredZip, groupWear, innerName, innerSaid, LINER_LENGTH, linerName, settleWear, versionName, wearLine, zippedWear } from './wear';

// 1888 as its material has it (10-21): four shells alone, the same four over a black down liner, a beige fleece liner worn alone.
const images = [
  { id: 'M1', role: '主体', color: '乌梅紫', inner: '' },
  { id: 'M2', role: '主体', color: '幻影黑', inner: '' },
  { id: 'M3', role: '主体', color: '乌梅紫', inner: '羽绒', innerColor: '黑色' },
  { id: 'M4', role: '主体', color: '幻影黑', inner: '羽绒', innerColor: '黑色' },
  { id: 'M5', role: '内胆', color: '米色', inner: '摇粒绒', innerColor: '米色' },
  { id: 'M6', role: '主体', color: '', colorsSeen: ['乌梅紫', '幻影黑'] },
  // A group photo where one wears the beige liner alone: beige is not a shell colour.
  { id: 'M7', role: '主体', color: '', colorsSeen: ['乌梅紫', '米色'] },
  // A poster of both shells, one over the down liner: the shell wearing it is not named, so it pairs neither.
  { id: 'M8', kind: '海报', role: '主体', color: '', colorsSeen: ['乌梅紫', '幻影黑'], inner: '棉', innerColor: '黑色' },
];
const colors = ['乌梅紫', '幻影黑', '米色'];

describe('settleWear: what the material shows, never pieced together (10-21)', () => {
  it('keeps each version with the images and colours that show it', () => {
    const w = settleWear({ type: '内胆', why: '文件夹写羽绒，有米色内胆单拍', versions: [
      { kind: '单外壳', colors: ['乌梅紫'], from: ['M1', 'M2', 'M6'] },
      { kind: '外壳加内胆', inner: '羽绒', colors: ['乌梅紫'], from: ['M3', 'M4'] },
      { kind: '单内胆', inner: '摇粒绒', from: ['M5'] },
    ] }, images, colors)!;
    expect(w.type).toBe('内胆');
    expect(w.versions.map(v => [versionName(v), v.colors, v.from])).toEqual([
      ['单外壳', ['乌梅紫', '幻影黑'], ['M1', 'M2', 'M6']],
      ['外壳 + 羽绒内胆', ['乌梅紫', '幻影黑'], ['M3', 'M4']],
      ['单穿摇粒绒内胆', ['米色'], ['M5']],
    ]);
  });
  it('drops a version no image shows: a shell photo and a liner photo are not 外壳 + that liner, a liner under a shell is not worn alone', () => {
    const w = settleWear({ type: '内胆', versions: [
      { kind: '外壳加内胆', inner: '摇粒绒', from: ['M1', 'M5'] },
      { kind: '单内胆', inner: '羽绒', from: ['M3'] },
      { kind: '外壳加内胆', inner: '羽绒', from: ['M3'] },
      { kind: '单外壳', from: ['M3'] },
    ] }, images, colors)!;
    expect(w.versions.map(versionName)).toEqual(['外壳 + 羽绒内胆']);
  });
  it('one shell colour over one liner colour is one liner: the material most images show', () => {
    const odd = [...images, { id: 'M9', kind: '模特实拍', role: '主体', color: '乌梅紫', inner: '棉', innerColor: '黑色' }, { id: 'M10', role: '主体', color: '乌梅紫', inner: '羽绒', innerColor: '黑色' }];
    expect(settleWear({ type: '内胆', versions: [{ kind: '外壳加内胆', inner: '棉', from: ['M9'] }, { kind: '外壳加内胆', inner: '羽绒', from: ['M3'] }] }, odd, colors)!.versions.map(versionName)).toEqual(['外壳 + 羽绒内胆']);
  });
  it('a version a poster or detail page alone shows is not offered', () => {
    expect(settleWear({ type: '内胆', versions: [{ kind: '外壳加内胆', inner: '棉', from: ['M8'] }, { kind: '外壳加内胆', inner: '羽绒', from: ['M3'] }] }, images, colors)!.versions.map(versionName)).toEqual(['外壳 + 羽绒内胆']);
  });
  it('a 3-in-1 whose liner is never shown is worn as 薄款; 薄款 and 一体 have no versions', () => {
    expect(settleWear({ type: '内胆', versions: [{ kind: '单外壳', from: ['M1'] }] }, images, colors)).toMatchObject({ type: '薄款', versions: [] });
    expect(settleWear({ type: '一体', versions: [{ kind: '单外壳', from: ['M1'] }] }, images, colors)).toMatchObject({ type: '一体', versions: [] });
    expect(settleWear({ type: '厚款' }, images, colors)).toBeNull();
  });
});

// 8828 (10-28): a 软壳 liner and a 羽绒 one; a fixed list of 摇粒绒 / 羽绒 / 棉 / 其他 had no word for the first.
describe('a liner is named as the material calls it', () => {
  const shells = [
    { id: 'S1', kind: '静物', role: '主体', color: '黑色', inner: '软壳', innerColor: '黑色' },
    { id: 'S2', kind: '静物', role: '内胆', color: '黑色', inner: '软壳', innerColor: '黑色' },
    { id: 'S3', kind: '静物', role: '主体', color: '冰川蓝', inner: '羽绒', innerColor: '藏青' },
  ];
  it('any short word is a liner; 「内胆」, 「其他」 and spaces are not part of the name, 抓绒 is 摇粒绒', () => {
    expect(['软壳内胆', ' 可拆卸针织内胆', '抓绒', '其他', '', undefined].map(innerName)).toEqual(['软壳', '针织', '摇粒绒', '', '', '']);
    const w = settleWear({ type: '内胆', versions: [
      { kind: '外壳加内胆', inner: '软壳内胆', from: ['S1'] }, { kind: '单内胆', inner: '软壳', from: ['S2'] },
      { kind: '外壳加内胆', inner: '羽绒', from: ['S3'] }, { kind: '外壳加内胆', inner: '其他', from: ['S1'] },
    ] }, shells, ['黑色', '冰川蓝'])!;
    expect(w.versions.map(versionName)).toEqual(['外壳 + 软壳内胆', '单穿软壳内胆', '外壳 + 羽绒内胆']);
  });
  it('a name the material\'s words carry stands; one from the look alone is to confirm', () => {
    const words = ['8828款三合一/软壳静物/3T4A5132.jpg', '可拆卸羽绒内胆'];
    expect([innerSaid('软壳', words), innerSaid('羽绒', words), innerSaid('摇粒绒', words), innerSaid('', words)]).toEqual([true, true, false, false]);
  });
  it('the plan\'s own name for a liner goes on the images, the material\'s still finds its photos', () => {
    expect(versionName({ kind: '外壳加内胆', inner: '摇粒绒', name: '软壳' })).toBe('外壳 + 软壳内胆');
    expect(linerName({ inner: '摇粒绒' })).toBe('摇粒绒');
  });
});

// 6609 (10-23): a flap hides the zip when closed; 「拉链拉到胸口」 drew a pull floating on the flap.
describe('a zip under a flap', () => {
  const g6609 = ['前中为全开合拉链，外覆宽直门襟，闭合时遮住链齿；领口和门襟下端可见圆形按扣。', '下摆平直'];
  it('is read from the garment\'s own description, and an open zip is not', () => {
    expect(coveredZip(g6609)).toBe(true);
    expect(coveredZip(['门襟拉链外露，拉到胸口', '帽子可拆，拉链连接'])).toBe(false);
  });
  it('is worn closed with no pull, open with the pull at the hem, and an open zip as before', () => {
    expect(wearLine(undefined, undefined, undefined, true)).toMatch(/门襟合到胸口.*不画拉头和链齿/);
    expect(wearLine(undefined)).toBeNull();
    expect(wearLine('一体', undefined, undefined, true)).toMatch(/^门襟一直合到最顶，拉链藏在门襟下面/);
    expect(wearLine('一体')).toMatch(/^拉链一直拉到最顶/);
    expect(wearLine('内胆', 3, '黑色', true)).toMatch(/拉头在下摆底端，衣服中间不出现单独的拉头/);
    expect(zippedWear(true)).toMatch(/门襟一直合到最顶/); expect(zippedWear(false)).toMatch(/^拉链一直拉到最顶/);
  });
});

describe('the liner on the main images (10-25)', () => {
  it('is as long as the shell, wherever it shows', () => {
    expect(wearLine('内胆', 3, '黑色')).toContain(LINER_LENGTH);
    expect(wearLine('内胆')).toContain(LINER_LENGTH);
    expect(wearLine('内胆', 3, '黑色')).toMatch(/材质、表面纹理、厚薄、长度/);
  });
  it('several colours each over their own liner by name; one with none zipped up', () => {
    const w = groupWear([{ shell: '白色', liner: '浅灰色摇粒绒' }, { shell: '翠绿', liner: '黑色摇粒绒' }, { shell: '咖啡' }]);
    expect(w).toMatch(/白色里面是浅灰色摇粒绒内胆，翠绿里面是黑色摇粒绒内胆/);
    expect(w).toMatch(/咖啡拉链一直拉到最顶/);
    expect(w).toContain(LINER_LENGTH);
    expect(groupWear([{ shell: '咖啡' }, { shell: '黑色', liner: '' }])).not.toContain('内胆拉链');
  });
});
