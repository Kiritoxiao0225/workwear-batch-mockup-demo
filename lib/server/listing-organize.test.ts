import { describe, expect, it } from 'vitest';
import { chooseMaterials, parseOrganized, type SortedImage } from './listing-organize';
import { usableAsIs } from '../listing/draft';

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
    expect(chosen.parts.map(p => [p.part, p.pick])).toEqual([['正面全身', 'M3'], ['领口', 'M5']]);
  });

  it('uses only a clean front still life or render as the product image', () => {
    expect(usableAsIs(img('A', { kind: '静物', front: true }))).toBe(true);
    expect(usableAsIs(img('B', { kind: '3D渲染', front: true, logo: true }))).toBe(false);
    expect(usableAsIs(img('C', { kind: '模特实拍', front: true }))).toBe(false);
    expect(usableAsIs(img('D', { kind: '静物' }))).toBe(false);
  });
});

describe('structure parts', () => {
  it('names the parts after what the garment has, most close-ups first and the back last', () => {
    const sorted = {
      images: [img('M1', { kind: '静物', color: '黑色', front: true }), img('M2', { kind: '细节特写', detail: '连帽' }), img('M3', { kind: '细节特写', detail: '连帽' }),
        img('M4', { kind: '静物', detail: '背面' }), img('M5', { kind: '细节特写', detail: '下摆抽绳' }), img('M6', { kind: '模特实拍', detail: '连帽' })],
      colors: [{ name: '黑色', hex: '#111', from: [] }], points: [], notes: [],
    };
    const chosen = chooseMaterials(sorted, []);
    expect(chosen.parts.map(p => [p.part, p.pick])).toEqual([['正面全身', 'M1'], ['连帽', 'M2'], ['下摆抽绳', 'M5'], ['背面', 'M4']]);
    expect(parseOrganized(JSON.stringify({ images: [{ id: 'M1', kind: '细节特写', detail: '帽檐调节扣' }], colors: [] }), ['M1']).images[0].detail).toBe('帽檐调节扣');
  });
});

describe('parseOrganized', () => {
  it('keeps only kinds of point, ways of drawing and categories that exist', () => {
    const data = parseOrganized(JSON.stringify({ images: [], colors: [], category: 'workwear', categoryWhy: '素材写了团体定制',
      points: [{ type: '功能', text: '三防面料', concept: 'triple', proof: 'water-beads' }, { type: '做工', text: '贴腕袖口', concept: 'made-up', proof: 'nope', part: '袖口' }],
      checks: [{ concept: 'warm', seen: '不像', why: '单层' }, { concept: 'made-up', seen: '有' }], titles: { 功能: ['三防面料 雨天不怕'], 海报: ['不要'] } }), []);
    expect(data.category).toBe('workwear');
    expect(data.points.map(p => [p.concept, p.proof, p.part])).toEqual([['triple', 'water-beads', ''], [null, '', '袖口']]);
    expect(data.checks).toEqual([{ concept: 'warm', seen: '不像', why: '单层' }]);
    expect(data.titles).toEqual({ 功能: ['三防面料 雨天不怕'] });
    expect(parseOrganized(JSON.stringify({ images: [], colors: [], category: '不知道' }), []).category).toBe('generic');
  });

  it('keeps images the model skipped and drops ids it made up', () => {
    const data = parseOrganized(JSON.stringify({ images: [{ id: 'M1', kind: '奇怪的', front: true }, { id: 'M9', kind: '静物' }], colors: [{ name: '黑色', from: ['M1', 'M9'] }] }), ['M1', 'M2']);
    expect(data.images.map(i => [i.id, i.kind])).toEqual([['M1', '无关'], ['M2', '无关']]);
    expect(data.colors[0].from).toEqual(['M1']);
  });
});
