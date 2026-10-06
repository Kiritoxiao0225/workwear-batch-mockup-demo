import { describe, expect, it } from 'vitest';
import { chooseMaterials, parseOrganized, type SortedImage } from './listing-organize';
import { usableAsIs } from '../listing/plan';

const img = (id: string, over: Partial<SortedImage>): SortedImage => ({ id, kind: '模特实拍', color: '', front: false, detail: '', text: false, logo: false, same: '', ...over });

describe('chooseMaterials', () => {
  it('picks a clean still life per colour and never a rack of several garments as the full front view', () => {
    const sorted = {
      images: [
        img('M1', { kind: '静物', front: true }), // a rack of all colours: no single colour
        img('M2', { kind: '模特实拍', color: '黑色', front: true }),
        img('M3', { kind: '静物', color: '黑色', front: true }),
        img('M4', { kind: '静物', color: '黑色', front: true, logo: true }),
        img('M5', { kind: '细节特写', detail: '领口' }),
        img('M6', { kind: '静物', color: '黑色', front: true, same: 'M3' }),
      ],
      colors: [{ name: '黑色', hex: '#111', from: ['M2'] }, { name: '藏青', hex: '#1d2a44', from: [] }],
      points: [], notes: [],
    };
    const chosen = chooseMaterials(sorted, [{ id: 'M4', width: 3000, height: 3000 }, { id: 'M3', width: 800, height: 800 }]);
    expect(chosen.colors.map(c => [c.name, c.pick])).toEqual([['黑色', 'M3'], ['藏青', null]]);
    expect(chosen.parts[0].pick).toBe('M3');
    expect(chosen.parts.find(p => p.part === '领口')?.pick).toBe('M5');
    expect(chosen.parts.filter(p => !p.pick).map(p => p.part)).toEqual(['拉链和袖口', '口袋', '面料', '背面']);
  });

  it('uses only a clean front still life or render as the product image', () => {
    expect(usableAsIs(img('A', { kind: '静物', front: true }))).toBe(true);
    expect(usableAsIs(img('B', { kind: '3D渲染', front: true, logo: true }))).toBe(false);
    expect(usableAsIs(img('C', { kind: '模特实拍', front: true }))).toBe(false);
    expect(usableAsIs(img('D', { kind: '静物' }))).toBe(false);
  });
});

describe('parseOrganized', () => {
  it('keeps images the model skipped and drops ids it made up', () => {
    const data = parseOrganized(JSON.stringify({ images: [{ id: 'M1', kind: '奇怪的', front: true }, { id: 'M9', kind: '静物' }], colors: [{ name: '黑色', from: ['M1', 'M9'] }] }), ['M1', 'M2']);
    expect(data.images.map(i => [i.id, i.kind])).toEqual([['M1', '无关'], ['M2', '无关']]);
    expect(data.colors[0].from).toEqual(['M1']);
  });
});
