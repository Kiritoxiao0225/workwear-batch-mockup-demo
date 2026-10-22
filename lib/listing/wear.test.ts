import { describe, expect, it } from 'vitest';
import { settleWear, versionName } from './wear';

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
