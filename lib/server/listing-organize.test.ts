import { describe, expect, it } from 'vitest';
import { applyLiners, applySkuCheck, parseSkuCheck, skuCheckImages, chooseMaterials, linerCandidates, linerFolderRest, linerRequest, mergePoints, parseLinerBatch, mergeSameColors, parseOrganized, parsePoints, parseRead, parseSorted, parseWhole, pointsRequest, readRequest, recolored, settleCopies, unlistedColors, wholeRequest, worthReading, type SortedImage } from './listing-organize';
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

describe('a full front view when none is whole and closed (10-19)', () => {
  it('takes the first colour\'s own image, so the plan can start', () => {
    const sorted = {
      images: [img('M4', { kind: '静物', color: '黑色', front: false, facing: '正对', role: '主体' }), img('M1', { kind: '静物', color: '牛仔蓝', front: false, facing: '正对', role: '主体' }), img('M75', { kind: '静物', color: '黑色', front: true, role: '内胆' })],
      colors: [{ name: '黑色', hex: '#111', from: [] }, { name: '牛仔蓝', hex: '#345', from: [] }], points: [], notes: [],
    };
    const chosen = chooseMaterials(sorted, []);
    expect(chosen.colors.map(c => c.pick)).toEqual(['M4', 'M1']);
    expect(chosen.parts[0]).toMatchObject({ part: '正面全身', pick: 'M4' });
  });
});

describe('the reading writes a short name for each point (10-19)', () => {
  it('keeps it, and an answer without one still reads', () => {
    const images = [img('M1', { kind: '卖点图' })];
    const read = (points: object[]) => parseRead(JSON.stringify({ colors: [], points, notes: [], category: 'workwear', categoryWhy: '', checks: [], titles: {}, recolor: {} }), images);
    expect(read([{ type: '功能', text: '可呼吸冲锋衣透气面料', short: '透气面料', from: ['M1'] }]).points[0].short).toBe('透气面料');
    expect(read([{ type: '功能', text: '防风', from: ['M1'] }]).points[0].short).toBe('');
  });
});


describe('a big product read in parts (10-26)', () => {
  const point = (text: string, from: string[], extra = {}) => ({ type: '功能', text, note: '', from, why: '', concept: null, proof: '', part: '', short: '', ...extra });
  it('asks each part only for its share, in the one-call wording', () => {
    const system = (r: { messages: { content: unknown }[] }) => String(r.messages[0].content);
    const one = system(readRequest({ views: [], model: 'm', product: 'p', images: [] }));
    const points = system(pointsRequest({ views: [], model: 'm', product: 'p', images: [] })), whole = system(wholeRequest({ views: [], model: 'm', product: 'p', images: [], points: [] }));
    const pointRule = one.split('\n').find(l => l.startsWith('- points：'))!;
    expect(points).toContain(pointRule); expect(whole).not.toContain(pointRule);
    expect(points).not.toContain('- colors：'); expect(points).not.toContain('母版（编号');
    expect(whole).toContain(one.split('\n').find(l => l.startsWith('- colors：'))!);
    expect(whole).toContain('卖点已经读好，不用再输出');
  });
  it('keeps a point read in two groups once, with the pictures of both', () => {
    const merged = mergePoints([{ points: [point('三层防水', ['M2']), point('立体剪裁', ['M3'])], notes: ['M4 字看不清'] }, { points: [point('三层 防水', ['M9'])], notes: ['M4 字看不清'] }]);
    expect(merged.points.map(p => [p.text, p.from])).toEqual([['三层防水', ['M2', 'M9']], ['立体剪裁', ['M3']]]);
    expect(merged.notes).toEqual(['M4 字看不清']);
    expect(parsePoints(JSON.stringify({ points: [point('防风', ['M1'])] })).points).toHaveLength(1);
  });
  it('puts the whole product together with the points already read, as one call would', () => {
    const images: SortedImage[] = [{ id: 'M1', kind: '模特实拍', color: '黑色', front: true, detail: '', parts: [], text: false, logo: false, same: '', person: '', face: false }];
    const read = { points: [point('三层防水', ['M1', 'M99'])], notes: ['卖点页有一张裁掉了'] };
    const whole = parseWhole(JSON.stringify({ colors: [{ name: '黑色', hex: '#111', from: ['M1'] }], category: 'workwear', notes: ['没有背面图'], points: [point('不该用这条', ['M1'])] }), images, read);
    expect(whole.points.map(p => [p.text, p.from])).toEqual([['三层防水', ['M1']]]);
    expect(whole.notes).toEqual(['卖点页有一张裁掉了', '没有背面图']);
    expect(whole.category).toBe('workwear');
  });
});

// 8828 (10-28): its 软壳 liner shot alone looks like a jacket of its own, in a folder no liner word names.
describe('the liner check looks in every folder and keeps the material\'s name', () => {
  const img = (id: string, kind: SortedImage['kind'], extra: Partial<SortedImage> = {}): SortedImage => ({ id, kind, color: '', front: true, detail: '', parts: [], text: false, logo: false, same: '', person: '', face: false, ...extra });
  const paths: Record<string, string> = { A1: '8828/A1.jpg', A2: '8828/A2.jpg', B1: '8828/软壳静物/B1.jpg', B2: '8828/软壳静物/B2.jpg', B3: '8828/软壳静物/B3.jpg', B4: '8828/软壳静物/B4.jpg', B5: '8828/软壳静物/B5.jpg', C1: '8828/羽绒静物/C1.jpg', D1: '8828/详情/D1.jpg' };
  const pathOf = (id: string) => paths[id] ?? '';
  const images = [img('A1', '静物'), img('A2', '静物', { open: true }), ...['B1', 'B2', 'B3', 'B4', 'B5'].map(id => img(id, '静物')), img('C1', '静物'), img('D1', '详情页')];
  it('a few photos of each folder are looked at, then the rest of a folder where one shows a liner', () => {
    const checked = linerCandidates(images, pathOf);
    expect(checked[0]).toBe('A2');
    expect(new Set(checked)).toEqual(new Set(['A2', 'A1', 'B1', 'B2', 'B3', 'C1']));
    const checks = parseLinerBatch(JSON.stringify({ images: [{ id: 'B1', role: '内胆', open: true, inner: '软壳内胆', innerColor: '黑色' }, { id: 'A2', role: '主体', open: true, inner: '羽绒', innerColor: '藏青' }] }));
    expect(checks[0].inner).toBe('软壳');
    expect(linerFolderRest(images, checks, checked, pathOf)).toEqual(['B4', 'B5']);
    expect(applyLiners(checks, images, checked).find(i => i.id === 'B1')).toMatchObject({ role: '内胆', inner: '软壳' });
  });
  it('a product with no sign of a liner is not looked at again', () => {
    const plain = [img('P1', '静物'), img('P2', '模特实拍')], at = (id: string) => `T恤/${id}.jpg`;
    expect(linerCandidates(plain, at, '纯棉圆领T恤')).toEqual([]);
    expect(linerCandidates(plain, at, '8828款三合一冲锋衣')).toEqual(['P1', 'P2']);
  });
  it('each batch is told the names given before', () => {
    const text = JSON.stringify(linerRequest({ views: [], model: 'm', product: '8828', named: ['软壳', '羽绒'] }));
    expect(text).toContain('已经出现的内胆：软壳、羽绒');
  });
});

// 8828 (11-03): one grey soft-shell liner read as 米色 on the photos and 浅灰色 on the renders, and the pairs printed on its swatches missed.
describe('核对 SKU', () => {
  const img = (i: Partial<SortedImage> & { id: string }): SortedImage => ({ kind: '静物', color: '', front: false, detail: '', parts: [], text: false, logo: false, same: '', person: '', face: false, ...i } as SortedImage);
  const images = [
    img({ id: 'C1', kind: '颜色款图', color: '冰川蓝', role: '主体', text: true }),
    img({ id: 'C2', kind: '颜色款图', color: '未来灰', role: '主体', text: true }),
    img({ id: 'W1', kind: '模特实拍', color: '未来灰', role: '主体', inner: '软壳', innerColor: '浅灰色' }),
    img({ id: 'L1', color: '未来灰', role: '内胆', inner: '软壳', innerColor: '米色' }),
    img({ id: 'L2', kind: '3D渲染', color: '未来灰', role: '内胆', inner: '软壳', innerColor: '浅灰色' }),
    img({ id: 'L3', color: '冰川蓝', role: '内胆', inner: '软壳', innerColor: '浅蓝色' }),
  ];
  const organized = { images, colors: [{ name: '冰川蓝', hex: '', from: [] }, { name: '未来灰', hex: '', from: [] }], points: [{ text: '三合一（软壳内胆）', note: '', from: ['C2'] }],
    wear: { type: '内胆' as const, why: '', versions: [{ kind: '外壳加内胆' as const, inner: '软壳', colors: ['未来灰'], from: ['W1'] }, { kind: '单内胆' as const, inner: '软壳', colors: ['米色', '浅灰色', '浅蓝色'], from: ['L1', 'L2', 'L3'] }] } } as never;
  const check = parseSkuCheck(JSON.stringify({ versions: [{ kind: '外壳加内胆', inner: '软壳', colors: ['冰川蓝', '未来灰'], from: ['C1', 'C2', 'W1'], liners: { 冰川蓝: '浅蓝色', 未来灰: '米色' } }], rename: { 软壳: { 米色: '浅灰色', 浅蓝色: '没有的色' } } }));
  it('sends the colour images and the pages of the liner points, and a photo of each liner', () => {
    const pick = skuCheckImages(images, organized['points' as never]);
    expect([...pick.text].sort()).toEqual(['C1', 'C2']);
    expect([...pick.photos].sort()).toEqual(['L1', 'L2', 'L3', 'W1']);
  });
  it('one liner one colour name, and the printed pairs taken in', () => {
    const after = applySkuCheck(organized, check, ['C1', 'C2']);
    expect(after.images.find(i => i.id === 'L1')!.innerColor).toBe('浅灰色');
    expect(after.images.find(i => i.id === 'L3')!.innerColor).toBe('浅蓝色');
    expect(after.wear!.versions.map(v => [v.kind, v.colors, v.liners])).toEqual([
      ['外壳加内胆', ['冰川蓝', '未来灰'], { 冰川蓝: '浅蓝色', 未来灰: '浅灰色' }],
      ['单内胆', ['浅灰色', '浅蓝色'], undefined],
    ]);
  });
  it('a check that says nothing keeps the first reading\'s pairs', () => {
    const none = parseSkuCheck(JSON.stringify({ versions: [], rename: {} }));
    expect(applySkuCheck(organized, none, ['C1', 'C2']).wear!.versions.find(v => v.kind === '外壳加内胆')!.colors).toEqual(['未来灰']);
  });
});
