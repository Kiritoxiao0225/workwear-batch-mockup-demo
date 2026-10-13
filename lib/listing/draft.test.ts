import { describe, expect, it } from 'vitest';
import { categoryById } from './category';
import { fabricColor } from './scene';
import { DEMO_MATERIAL } from './demo/material';
import { checkDraft, replan, markMust, putOn, takeOff, fillModel, fillParts, missingParts, defaultDraft, draftImages, fitProof, notesOf, placesFor, planSlots, reviewPoints, staleMentions, tickPoint, usageOf, usedSlots, type Draft, type Point, closerTitle, closerSub, syncCloser, partPhoto, type Slot } from './draft';
import { LEGACY_LAYOUTS as BUILT_IN_LAYOUTS } from './legacy-layouts';
import { BUILT_IN_LAYOUTS as MASTERS, FLAT_EXAMPLE, capacity, cellZones, fitTemplate, mostCells, type Layout } from './templates';

const workwear = categoryById('workwear');
const commute = BUILT_IN_LAYOUTS[0];
const flat: Layout = { ...FLAT_EXAMPLE, id: 'flat', samples: [] };
const draft = (layout = commute) => defaultDraft(DEMO_MATERIAL, layout);
const tick = (d: Draft, texts: string[]) => texts.reduce((x, t) => tickPoint(x, x.points.find(p => p.text === t)!.id, true, commute), d);

describe('the points', () => {
  const points = reviewPoints(DEMO_MATERIAL, workwear);
  const extra = points.filter(p => p.group === '补充');
  it('puts the positioning point first and groups the rest by how many competitors show them', () => {
    expect(points[0]).toMatchObject({ text: '轻盈抗造工作服', group: '定位' });
    expect(points.find(p => p.text === '透气好活动')?.group).toBe('必打');
    expect(points.find(p => p.text === '男女同款')?.group).toBe('独有');
  });
  it('a kind that covers others weighs as much as they do: 三防 leads the features', () => {
    const features = points.filter(p => ['功能', '面料'].includes(p.type));
    expect(features[0].text).toBe('三防面料');
  });
  it('does not offer what the material already says or covers', () => {
    expect(extra.map(p => p.concept)).not.toEqual(expect.arrayContaining(['waterproof']));
    expect(extra.map(p => p.concept)).not.toContain('logo');
    expect(extra.map(p => p.concept)).not.toContain('stain');
  });
  it('offers at most five, a garment feature the garment does not look like having folded away', () => {
    expect(extra.filter(p => !p.folded).length).toBeLessThanOrEqual(5);
    expect(extra.find(p => p.concept === 'warm')).toMatchObject({ seen: '不像', folded: true });
    expect(extra.find(p => p.concept === 'delivery')).toMatchObject({ kind: '服务', on: false });
  });
});

describe('the images', () => {
  it('the second image is always the shop\'s service image: nothing to write, free', () => {
    const d = draft();
    expect(d.slots.map(s => s.task)).toEqual(['首图', '服务', '功能', '细节', '收口']);
    expect(d.slots[1]).toMatchObject({ shopService: 'shop', cells: [], colors: [] });
    expect(draftImages(d, commute, new Set()).find(i => i.slot === 'square:2')).toMatchObject({ free: true });
  });
  it('the shop\'s services stay on its own image: ticking more of them changes no image', () => {
    const d = tick(draft(), ['急速发货', '可开发票']);
    const { slots } = planSlots(d.points, workwear, commute, ['落霞橙', '黑色'], d.titles);
    expect(slots.map(s => s.task)).toEqual(['首图', '服务', '功能', '细节', '收口']);
    expect(slots[1].cells).toEqual([]);
  });
  it('the model demonstrates 三防, the cards show the rest, the heading is the AI\'s', () => {
    const feature = draft().slots.find(s => s.task === '功能')!;
    expect(feature).toMatchObject({ title: '三防面料 雨天不怕', act: 'water-arm' });
    expect(feature.cells.length).toBe(2);
  });
  it('without people the lead point goes on a card', () => {
    const feature = draft(flat).slots.find(s => s.task === '功能')!;
    expect(feature.act).toBeNull();
    expect(feature.cells[0].point).toBe(feature.lead);
  });
  it('fewer square images keep the ones that say the most', () => {
    const d = draft();
    expect(usedSlots(d, 3).map(i => d.slots[i].task)).toEqual(['首图', '功能', '收口']);
  });
  it('a ticked point takes free room on its own kind of image; unticking takes it off', () => {
    let d = draft();
    const pocket = d.points.find(p => p.text === '双侧拉链口袋')!;
    expect(usageOf(d).get(pocket.id)).toEqual(['第 4 张标签']);
    d = tickPoint(d, pocket.id, false, commute);
    expect(usageOf(d).get(pocket.id)).toBeUndefined();
    d = tickPoint(d, pocket.id, true, commute);
    expect(usageOf(d).get(pocket.id)).toEqual(['第 4 张标签']);
  });
  it('offers its own kind of image first when placing a point', () => {
    const d = tick(draft(), ['防风']);
    expect(placesFor(d, 'c-windproof', commute)[0].label).toMatch(/^第 3 张/);
  });
  it('draws a person\'s demonstration only where there are people', () => {
    const pocket = reviewPoints(DEMO_MATERIAL, workwear).find(p => p.text === '双侧拉链口袋') as Point;
    expect(fitProof(pocket, flat.templates.细节.square, workwear)).toBe('pocket-open');
    expect(fitProof(pocket, commute.templates.实用.square, workwear)).toBe('pocket-phone');
  });
  it('the shop\'s service image takes no colour, whatever the layout', () => {
    const material = { ...DEMO_MATERIAL, points: [...DEMO_MATERIAL.points, { type: '服务定制', text: '急速发货', from: [] }, { type: '服务定制', text: '可开发票', from: [] }] };
    const service = (layout: Layout) => defaultDraft(material, layout).slots.find(s => s.task === '服务');
    expect(service(BUILT_IN_LAYOUTS[1])?.colors).toEqual([]);
    expect(service(commute)?.colors).toEqual([]);
  });
});

describe('notes and checks', () => {
  it('draws a part the material has no photo of another way, and refuses to generate it as a close-up', () => {
    const d = draft(), i = d.slots.findIndex(s => s.task === '细节');
    expect(checkDraft(d, commute).red.join()).toContain('素材里没有袖口的照片');
    const settled = fillParts(d, []);
    expect(missingParts(settled, settled.slots[i])).toEqual([]);
    expect(checkDraft(settled, commute).red).toEqual([]);
  });
  it('finds the close-up in the material when it has one', () => {
    const d = fillParts(draft(), [{ id: 'M43', detail: '袖口' }]), i = d.slots.findIndex(s => s.task === '细节');
    expect(d.parts).toContainEqual({ part: '袖口', pick: 'M43' });
    expect(missingParts(d, d.slots[i])).toEqual([]);
  });
  it('names the words that still talk about a replaced cell', () => {
    expect(staleMentions({ title: '细节经得起看', sub: '领口、拉链、袖口逐一放大', tags: ['利落立领'] }, ['贴腕袖口'])).toEqual(['小字「领口、拉链、袖口逐一放大」']);
  });
  it('the demo plan, settled, has nothing red and no notes', () => {
    const c = checkDraft(fillParts(draft(), []), commute);
    expect(c.red).toEqual([]);
    expect(c.warn).toEqual([]);
    expect(checkDraft(fillParts(draft(), [{ id: 'M43', detail: '袖口' }]), commute).warn).toEqual([]);
  });
});

describe('the two rounds', () => {
  it('makes the cast and the square images first, the 3:4 and the long image in the second round', () => {
    const items = draftImages(draft(), commute, new Set());
    expect(items.filter(i => i.round === 1).map(i => i.slot)).toEqual(expect.arrayContaining(['cast', 'square:1', 'square:5', 'sku:M30', 'product:M30']));
    expect(items.filter(i => i.round === 2).map(i => i.slot)).toEqual(['portrait:1', 'portrait:2', 'portrait:3', 'portrait:4', 'portrait:5', 'long:1']);
  });
  it('never more 3:4 images than square ones', () => {
    const d = { ...draft(), counts: { square: 3, portrait: 5, long: 0 } };
    expect(draftImages(d, commute, new Set()).filter(i => i.ratio === 'portrait')).toHaveLength(3);
  });
  it('a layout without people has no cast', () => {
    expect(draftImages(draft(flat), flat, new Set()).some(i => i.slot === 'cast')).toBe(false);
  });
  it('a SKU image on the template shows each colour on a model: a colour without its own photo has its model drawn (paid), and needs the cast', () => {
    const m5 = MASTERS.find(l => l.id === 'M5')!, d = draft(m5), picks = d.colors.filter(c => c.pick).map(c => c.pick!);
    const none = draftImages(d, m5, new Set());
    expect(none.filter(i => i.slot.startsWith('skumodel:')).map(i => i.slot)).toEqual(picks.map(p => `skumodel:${p}`));
    expect(none.filter(i => i.slot.startsWith('skumodel:')).every(i => !i.free)).toBe(true);
    expect(none.some(i => i.slot === 'cast')).toBe(true);
    const all = draftImages(d, m5, new Set(), new Set(picks));
    expect(all.some(i => i.slot.startsWith('skumodel:'))).toBe(false);
    expect(all.filter(i => i.slot.startsWith('sku:')).every(i => i.free)).toBe(true);
  });
  it('a cast drawn from the material is a man and a woman, each paid', () => {
    const d = { ...draft(), model: { lead: '男' as const, photos: { 女: 'M9' } } };
    expect(draftImages(d, commute, new Set()).filter(i => i.slot.startsWith('cast')).map(i => i.slot)).toEqual(['cast:男', 'cast:女']);
  });
});

describe('the models', () => {
  const shot = (id: string, person: string, face: boolean, same = '') => ({ id, kind: '模特实拍', person, face, same });
  it('picks a clear single photo of each gender from the material', () => {
    const images = [shot('M1', '男', false), shot('M2', '男女', true), shot('M3', '男', true), shot('M4', '女', true, 'M5'), shot('M5', '女', true)];
    expect(fillModel(draft(), images).model).toEqual({ lead: '男', photos: { 男: 'M3', 女: 'M5' } });
  });
  it('leaves the AI to make up the cast when no face is clear, and keeps a choice already made', () => {
    expect(fillModel(draft(), [shot('M1', '男', false)]).model.photos).toBeUndefined();
    const chosen = { ...draft(), model: { lead: '女' as const } };
    expect(fillModel({ ...chosen, model: { ...chosen.model, photos: {} } }, [shot('M3', '男', true)]).model.photos).toEqual({});
  });
});

describe('templates', () => {
  it('both shapes of an image hold the same points', () => {
    for (const l of [...BUILT_IN_LAYOUTS, flat]) for (const [task, t] of Object.entries(l.templates)) {
      expect({ task, ...capacity(t.portrait) }).toEqual({ task, ...capacity(t.square) });
    }
  });
  it('with fewer points the cards share the room of the full set', () => {
    const t = fitTemplate(commute.templates.服务.square, 2), icons = t.zones.filter(z => z.kind === 'icon');
    expect(icons).toHaveLength(2);
    // Two cards side by side, each as tall as both rows of the full set.
    expect(icons[0].box[3]).toBeGreaterThan(30);
  });
});

describe('the images that say something and the points the user must show', () => {
  const m1 = MASTERS.find(l => l.id === 'M1')!, m2 = MASTERS.find(l => l.id === 'M2')!, m4 = MASTERS.find(l => l.id === 'M4')!;
  it('go by kind of point, as the master has them: a feature image and a close-up image, never titled like the cover', () => {
    const d = defaultDraft(DEMO_MATERIAL, m4), used = usedSlots(d, d.counts.square).map(i => d.slots[i]);
    expect(used.map(s => s.task)).toEqual(['首图', '服务', '功能', '细节', '收口']);
    for (const s of used.slice(2, 4)) expect(s.title).not.toBe(used[0].title);
    expect(used[3].cells.length).toBe(4);
  });
  it('a cover shot in the studio says what the garment is (its build, then the category) with 团体定制, when the material has no positioning', () => {
    const m5 = MASTERS.find(l => l.id === 'M5')!, base = defaultDraft(DEMO_MATERIAL, m4);
    const points = base.points.map(p => p.type === '定位' ? { ...p, on: false } : p.text === '透气好活动' ? { ...p, note: '可拆卸内胆，一衣三穿' } : p);
    for (const layout of [m4, m5]) {
      const cover = replan({ ...base, points }, layout).slots[0];
      expect(cover.title).toBe('三合一 冲锋衣');
      expect(cover.tags[0]).toBe('团体定制');
    }
    // On location the cover keeps its point (the picture acts it out); with a positioning point, that one.
    expect(replan({ ...base, points }, m1).slots[0].title).not.toBe('三合一 冲锋衣');
    expect(defaultDraft(DEMO_MATERIAL, m4).slots[0].title).toBe('轻盈抗造工作服');
  });
  it('an image of fabric only shows the lightest colour on a light master, the darkest on a dark one', () => {
    const colors = [{ name: '黑色', hex: '#202024' }, { name: '象牙白', hex: '#EDEAE2' }, { name: '红色', hex: '#E20E23' }];
    expect(fabricColor('M4', colors)?.name).toBe('象牙白');
    expect(fabricColor('M2', colors)?.name).toBe('黑色');
  });
  it('on every master the images that say something are a feature image and then a close-up image, even when one demonstration leaves many feature points', () => {
    for (const layout of MASTERS) {
      const d = defaultDraft(DEMO_MATERIAL, layout), used = usedSlots(d, d.counts.square).map(i => d.slots[i].task);
      expect(used.slice(2, 4)).toEqual(['功能', '细节']);
    }
  });
  it('a point taken off stays off through 按新卖点重排; a point put on stays on', () => {
    const m4 = MASTERS.find(l => l.id === 'M4')!;
    let d = defaultDraft(DEMO_MATERIAL, m4);
    const shown = [...usageOf(d).keys()].find(id => usageOf(d).get(id)!.some(w => /格/.test(w)))!;
    d = takeOff(d, shown, m4);
    expect(usageOf(d).has(shown)).toBe(false);
    expect(usageOf(replan(d, m4)).has(shown)).toBe(false);
    const off = d.points.find(p => p.kind === '衣服' && p.type !== '定位' && !usageOf(d).has(p.id) && placesFor(d, p.id, m4).length)!;
    d = putOn(d, off.id, placesFor(d, off.id, m4)[0]);
    expect(usageOf(d).has(off.id)).toBe(true);
    expect(usageOf(replan(d, m4)).has(off.id)).toBe(true);
  });
  it('points the user must show take cards, squeezing the image up to six', () => {
    let d = defaultDraft(DEMO_MATERIAL, m1);
    const musts = d.points.filter(p => p.kind === '衣服' && p.on && !usageOf(d).has(p.id) && p.type !== '定位');
    expect(musts.length).toBeGreaterThan(0);
    for (const p of musts) d = markMust(d, p.id, true, m1);
    const content = usedSlots(d, d.counts.square).map(i => d.slots[i]).filter(s => s.task === '功能' || s.task === '细节');
    for (const p of musts) expect(content.some(s => s.cells.some(c => c.point === p.id))).toBe(true);
    expect(content.every(s => s.cells.length <= 6)).toBe(true);
    expect(cellZones(fitTemplate(m1.templates.功能.square, 5))).toHaveLength(5);
  });
  it('an image drawn as one demonstration takes no more cards', () => {
    expect(mostCells(m2.templates.功能.square)).toBe(1);
    expect(cellZones(fitTemplate(m2.templates.功能.square, 3))).toHaveLength(1);
  });
});

describe('the closer\'s words', () => {
  it('says 团体定制 and the count, over the functions in short words, and keeps the count with the colours', () => {
    expect(closerTitle(6)).toBe('团体定制 · 6色可选');
    expect(closerSub([{ text: 'IP4.0级防水', type: '功能' }, { text: '双重防风', type: '功能' }, { text: '耐磨抗撕', type: '功能' }, { text: '透气性强', type: '功能' }, { text: '撞色设计剪裁', type: '颜色款式' }])).toBe('防水 / 防风 / 耐磨 / 透气');
    expect(closerSub([{ text: '双重防风', type: '功能' }])).toBe('');
    const s = { task: '收口', title: closerTitle(6) } as Slot;
    expect(syncCloser(s, ['黑', '白', '灰']).title).toBe('团体定制 · 3色可选');
    expect(syncCloser({ ...s, title: '6色可选' }, ['黑', '白']).title).toBe('2色可选');
  });
});

describe('finding a photo of a part', () => {
  it('takes a detail page the point about the part names as its source, when nothing is sorted as that part', () => {
    const images = [{ id: 'M12', detail: '', kind: '详情页' }, { id: 'M29', detail: '门襟拉链', kind: '详情页' }, { id: 'M30', detail: '', kind: '详情页' }, { id: 'M40', detail: '', kind: '模特实拍' }];
    const points = [{ text: '魔术贴防风袖口', part: '袖口', from: ['M40', 'M30', 'M12'] }, { text: '两侧拉链口袋', part: '口袋', from: ['M29', 'M12'] }];
    expect(partPhoto(points, '袖口', images)?.id).toBe('M30');
    expect(partPhoto(points, '口袋', images)?.id).toBe('M29');
    expect(partPhoto(points, '门襟拉链', images)?.id).toBe('M29');
    expect(partPhoto(points, '帽子', [...images, { id: 'M50', detail: '', kind: '卖点图', parts: ['帽子', '袖口'] }])?.id).toBe('M50');
    expect(partPhoto(points, '下摆', images)).toBeUndefined();
  });
});
