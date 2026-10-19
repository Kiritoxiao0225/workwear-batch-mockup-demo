import { describe, expect, it } from 'vitest';
import { chooseMaterials, mergeSameColors, parseOrganized, parseRead, parseSorted, recolored, settleCopies, unlistedColors, worthReading, type SortedImage } from './listing-organize';
import { usableAsIs } from '../listing/draft';

const img = (id: string, over: Partial<SortedImage>): SortedImage => ({ id, kind: '模特实拍', color: '', front: false, detail: '', text: false, logo: false, same: '', person: '', face: false, ...over });

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

  it('keeps the AI pick of master and cover only where the master can use it', () => {
    const look = (l: object) => parseOrganized(JSON.stringify({ images: [], colors: [], look: l }), []).look;
    expect(look({ master: 'M2', place: '物业', sell: '防水', why: '三防多' })).toEqual({ master: 'M2', place: '物业', sell: '防水', why: '三防多' });
    expect(look({ master: 'M1', place: '登山', sell: '防水', why: '' })).toEqual({ master: 'M1', why: '' });
    expect(look({ master: 'M4', place: '工地', sell: '耐磨', why: '' })).toEqual({ master: 'M4', why: '' });
    expect(look({ master: 'M3', place: '工地', sell: '好看', why: '' })).toEqual({ master: 'M3', place: '工地', why: '' });
    expect(look({ master: 'M9', place: '工地' })).toBeNull();
    expect(parseOrganized(JSON.stringify({ images: [], colors: [] }), []).look).toBeNull();
  });

  it('keeps images the model skipped and drops ids it made up', () => {
    const data = parseOrganized(JSON.stringify({ images: [{ id: 'M1', kind: '奇怪的', front: true }, { id: 'M9', kind: '静物' }], colors: [{ name: '黑色', from: ['M1', 'M9'] }] }), ['M1', 'M2']);
    expect(data.images.map(i => [i.id, i.kind])).toEqual([['M1', '无关'], ['M2', '无关']]);
    expect(data.colors[0].from).toEqual(['M1']);
  });
});

describe('the analysis in parts', () => {
  it('keeps an image a batch skipped as unsorted, and forgets a copy of an image outside the batch', () => {
    const images = parseSorted(JSON.stringify({ images: [{ id: 'M1', kind: '静物', same: 'M9' }, { id: 'M2', kind: '细节特写', detail: '袖口', same: 'M1' }, { id: 'M7', kind: '静物' }] }), ['M1', 'M2', 'M3']);
    expect(images.map(i => [i.id, i.kind, i.same])).toEqual([['M1', '静物', ''], ['M2', '细节特写', 'M1'], ['M3', '无关', '']]);
  });
  it('puts the batches and the whole product together as one analysis', () => {
    const images = [img('M1', { kind: '静物', color: '黑色', front: true }), img('M2', { kind: '卖点图', text: true })];
    const o = parseRead(JSON.stringify({ colors: [{ name: '黑色', hex: '#111', from: ['M1', 'M9'] }], points: [{ type: '功能', text: '三级防水', from: ['M2'] }], category: 'workwear' }), images);
    expect(o.images).toHaveLength(2);
    expect(o.colors[0].from).toEqual(['M1']);
    expect(o.category).toBe('workwear');
    expect(worthReading([...images, img('M3', { kind: '无关' }), img('M4', { same: 'M1' })]).map(i => i.id)).toEqual(['M1', 'M2']);
  });
});

describe('colours written two ways', () => {
  it('drops a colour with no image that reads the same as one with an image, and keeps one only named in text', () => {
    const colors = [{ name: '黑拼白', hex: '', from: ['M47'] }, { name: '黑白拼', hex: '', from: [] }, { name: '藏青色', hex: '', from: [] }, { name: '卡其', hex: '', from: ['M3'] }, { name: '卡其色', hex: '', from: [] }];
    expect(mergeSameColors(colors).map(c => c.name)).toEqual(['黑拼白', '藏青色', '卡其']);
  });
});

describe('copies marked both ways round', () => {
  const img = (id: string, kind: SortedImage['kind'], same: string, color = '白 + 咖啡', text = false): SortedImage =>
    ({ id, kind, color, front: true, detail: '', parts: [], text, logo: false, same, person: '', face: false });
  it('keeps the still life of a pair that each say the other is the copy, and gives it to its colour', () => {
    const images = settleCopies([img('M5', '静物', 'M146'), img('M146', '颜色款图', 'M5', '白 + 咖啡', true), img('M60', '模特实拍', '')]);
    expect(images.find(i => i.id === 'M5')!.same).toBe('');
    expect(images.find(i => i.id === 'M146')!.same).toBe('M5');
    const chosen = chooseMaterials({ images, colors: [{ name: '白+咖啡', hex: '', from: ['M60'] }] }, []);
    expect(chosen.colors[0].pick).toBe('M5');
  });
  it('leaves a group that already has its original alone', () => {
    const images = settleCopies([img('M1', '静物', 'M2'), img('M2', '颜色款图', '')]);
    expect(images.map(i => i.same)).toEqual(['M2', '']);
  });
});

describe('colours named before the colours were known', () => {
  const img = (id: string, color: string) => ({ id, color });
  it('takes the reading\'s colour for an image sorted under a name of its own', () => {
    const out = recolored([img('M48', '橙色'), img('M44', '橙色'), img('M21', '爱马仕橙')], ['落霞橙', '爱马仕橙'], { M48: '爱马仕橙', M44: '不存在的色' });
    expect(out.map(i => i.color)).toEqual(['爱马仕橙', '橙色', '爱马仕橙']);
  });
  it('gives a label to the one colour whose name holds it, and guesses nothing when two do', () => {
    const out = recolored([img('M1', '蓝色'), img('M2', '橙色'), img('M3', '黑 色')], ['北欧蓝', '落霞橙', '爱马仕橙', '黑色']);
    expect(out.map(i => i.color)).toEqual(['北欧蓝', '橙色', '黑 色']);
  });
});

describe('liners, group photos and colours seen (10-15)', () => {
  it('never picks a liner photographed on its own for a colour or the full front view', () => {
    const sorted = {
      images: [
        img('M75', { kind: '静物', color: '黑色', front: true, role: '内胆' }),
        img('M4', { kind: '模特实拍', color: '黑色', front: true, role: '主体', person: '男' }),
      ],
      colors: [{ name: '黑色', hex: '#111', from: ['M75', 'M4'] }], points: [], notes: [],
    };
    const chosen = chooseMaterials(sorted, []);
    expect(chosen.colors[0]).toMatchObject({ pick: 'M4', candidates: ['M4'] });
    expect(chosen.parts[0].pick).toBe('M4');
  });
  it('with no whole front view of the jacket, takes the jacket open on its hanger, never its liner', () => {
    const sorted = {
      images: [
        img('M4', { kind: '静物', color: '黑色', front: false, role: '主体' }),
        img('M75', { kind: '静物', color: '黑色', front: true, role: '内胆' }),
        img('M9', { kind: '静物', color: '黑色', front: false }), // sorted before 10-16: no role, not a fallback
      ],
      colors: [{ name: '黑色', hex: '#111', from: ['M4', 'M75'] }], points: [], notes: [],
    };
    expect(chooseMaterials(sorted, []).colors[0]).toMatchObject({ pick: 'M4', candidates: ['M4'] });
  });
  it('takes a colour from a group photo only when it has no photo of its own', () => {
    const sorted = {
      images: [img('M17', { front: true, person: '多人', colorsSeen: ['白色', '军绿'] }), img('M18', { front: true, color: '白色', person: '女' })],
      colors: [{ name: '白色', hex: '#fff', from: ['M17', 'M18'] }, { name: '军绿', hex: '#4b5320', from: ['M17'] }], points: [], notes: [],
    };
    expect(chooseMaterials(sorted, []).colors.map(c => c.pick)).toEqual(['M18', 'M17']);
  });
  it('notes a colour seen on a garment that the colour list left out, but not a liner\'s or a shade it has', () => {
    const images = [img('M17', { person: '多人', colorsSeen: ['黑色', '白色', '军绿'] }), img('M75', { kind: '静物', role: '内胆', colorsSeen: ['浅紫'] }), img('M5', { colorsSeen: ['蓝色'] })];
    const notes = unlistedColors(images, ['黑色', '北欧蓝']);
    expect(notes).toEqual([expect.stringContaining('「白色」'), expect.stringContaining('「军绿」')]);
    expect(notes[0]).toContain('M17');
  });
  it('reads role and colours seen, and drops values it does not know', () => {
    const [a, b] = parseSorted(JSON.stringify({ images: [{ id: 'M1', kind: '静物', role: '内胆', colorsSeen: ['黑色'] }, { id: 'M2', kind: '静物', role: '外套', colorsSeen: '黑色' }] }), ['M1', 'M2']);
    expect(a).toMatchObject({ role: '内胆', colorsSeen: ['黑色'] });
    expect(b.role).toBeUndefined();
    expect(b.colorsSeen).toBeUndefined();
  });
  it('takes off a Markdown wrapper round the whole answer, and nothing else', () => {
    expect(parseSorted('```json\n{"images":[{"id":"M1","kind":"静物"}]}\n```', ['M1'])[0].kind).toBe('静物');
    expect(() => parseSorted('这是结果：```json\n{"images":[]}\n```', ['M1'])).toThrow('整理结果不是完整的 JSON');
  });
});

describe('a colour\'s reference faces the camera, and a still life in a scene is not its white image (10-19)', () => {
  it('takes the model facing the camera before a bigger photo of one turned half away', () => {
    const sorted = {
      images: [img('M414', { color: '乌梅紫', front: true, person: '男', facing: '侧身' }), img('M90', { color: '乌梅紫', front: true, person: '男', facing: '正对' })],
      colors: [{ name: '乌梅紫', hex: '#4b2a40', from: [] }], points: [], notes: [],
    };
    const chosen = chooseMaterials(sorted, [{ id: 'M414', width: 4000, height: 6000 }, { id: 'M90', width: 1200, height: 1800 }]);
    expect(chosen.colors[0].pick).toBe('M90');
    // Material sorted before 10-19 has no facing: the bigger photo, as before.
    const old = { ...sorted, images: sorted.images.map(i => ({ ...i, facing: undefined })) };
    expect(chooseMaterials(old, [{ id: 'M414', width: 4000, height: 6000 }, { id: 'M90', width: 1200, height: 1800 }]).colors[0].pick).toBe('M414');
    expect(parseSorted(JSON.stringify({ images: [{ id: 'M1', kind: '模特实拍', facing: '正对' }, { id: 'M2', kind: '模特实拍', facing: '斜着' }] }), ['M1', 'M2']).map(i => i.facing)).toEqual(['正对', undefined]);
  });
  it('a still life in a scene is not used as it is, and a white one comes before it', () => {
    expect(usableAsIs(img('A', { kind: '静物', front: true, plain: false }))).toBe(false);
    expect(usableAsIs(img('B', { kind: '静物', front: true, plain: true }))).toBe(true);
    const sorted = {
      images: [img('M219', { kind: '静物', color: '藏青', front: true, plain: false }), img('M220', { kind: '静物', color: '藏青', front: true, plain: true })],
      colors: [{ name: '藏青', hex: '#1d2a44', from: [] }], points: [], notes: [],
    };
    expect(chooseMaterials(sorted, [{ id: 'M219', width: 3000, height: 3000 }, { id: 'M220', width: 800, height: 800 }]).colors[0].pick).toBe('M220');
  });
});
