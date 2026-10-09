import { describe, expect, it } from 'vitest';
import { categoryById } from './category';
import { DEMO_MATERIAL } from './demo/material';
import { checkDraft, fillParts, missingParts, defaultDraft, draftImages, fitProof, notesOf, placesFor, planSlots, reviewPoints, staleMentions, structureHint, tickPoint, usageOf, usedSlots, type Draft, type Point } from './draft';
import { BUILT_IN_LAYOUTS, FLAT_EXAMPLE, capacity, fitTemplate, type Layout } from './templates';

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
  it('makes only the images the points fill: no service image for two service points, a scene image instead', () => {
    expect(draft().slots.map(s => s.task)).toEqual(['首图', '功能', '细节', '场景', '收口']);
  });
  it('a service image once there are three service points', () => {
    const d = tick(draft(), ['急速发货', '可开发票']);
    expect(structureHint(d, commute)).toContain('服务说明');
    const { slots } = planSlots(d.points, workwear, commute, ['落霞橙', '黑色'], d.titles);
    expect(slots.map(s => s.task)).toEqual(['首图', '服务', '功能', '细节', '收口']);
  });
  it('the model demonstrates 三防, the cards show the rest, the heading is the AI\'s', () => {
    const feature = draft().slots[1];
    expect(feature).toMatchObject({ title: '三防面料 雨天不怕', act: 'water-arm' });
    expect(feature.cells.length).toBe(2);
  });
  it('without people the lead point goes on a card', () => {
    const feature = draft(flat).slots[1];
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
    expect(usageOf(d).get(pocket.id)).toEqual(['第 3 张标签']);
    d = tickPoint(d, pocket.id, false, commute);
    expect(usageOf(d).get(pocket.id)).toBeUndefined();
    d = tickPoint(d, pocket.id, true, commute);
    expect(usageOf(d).get(pocket.id)).toEqual(['第 3 张标签']);
  });
  it('offers its own kind of image first when placing a point', () => {
    const d = tick(draft(), ['防风']);
    expect(placesFor(d, 'c-windproof', commute)[0].label).toMatch(/^第 2 张/);
  });
  it('draws a person\'s demonstration only where there are people', () => {
    const pocket = reviewPoints(DEMO_MATERIAL, workwear).find(p => p.text === '双侧拉链口袋') as Point;
    expect(fitProof(pocket, flat.templates.细节.square, workwear)).toBe('pocket-open');
    expect(fitProof(pocket, commute.templates.实用.square, workwear)).toBe('pocket-phone');
  });
  it('an image without the garment on it takes no colour', () => {
    const d = tick(draft(), ['急速发货', '可开发票']);
    const { slots } = planSlots(d.points, workwear, commute, ['落霞橙'], d.titles);
    const material = { ...DEMO_MATERIAL, points: [...DEMO_MATERIAL.points, { type: '服务定制', text: '急速发货', from: [] }, { type: '服务定制', text: '可开发票', from: [] }] };
    const service = (layout: Layout) => defaultDraft(material, layout).slots.find(s => s.task === '服务');
    expect(slots.some(s => s.task === '服务')).toBe(true);
    // 爆款暖光's service image is icons only; 通勤's lays the garment under the icons.
    expect(service(BUILT_IN_LAYOUTS[1])?.colors).toEqual([]);
    expect(service(commute)?.colors).toHaveLength(1);
  });
});

describe('notes and checks', () => {
  it('asks for a close-up picture of a part the structure images do not have', () => {
    const d = draft(), i = d.slots.findIndex(s => s.task === '细节');
    expect(notesOf(d, i, commute).join()).toContain('素材里没有袖口的照片');
  });
  it('finds the close-up in the material when it has one', () => {
    const d = fillParts(draft(), [{ id: 'M43', detail: '袖口' }]), i = d.slots.findIndex(s => s.task === '细节');
    expect(d.parts).toContainEqual({ part: '袖口', pick: 'M43' });
    expect(missingParts(d, d.slots[i])).toEqual([]);
  });
  it('names the words that still talk about a replaced cell', () => {
    expect(staleMentions({ title: '细节经得起看', sub: '领口、拉链、袖口逐一放大', tags: ['利落立领'] }, ['贴腕袖口'])).toEqual(['小字「领口、拉链、袖口逐一放大」']);
  });
  it('the demo plan has nothing red, and says which images have notes', () => {
    const c = checkDraft(draft(), commute);
    expect(c.red).toEqual([]);
    expect(c.warn).toEqual([3]);
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
