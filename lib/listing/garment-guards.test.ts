import { describe, expect, it } from 'vitest';
import { DEMO_MATERIAL } from './demo/material';
import { checkDraft, colorKeys, defaultDraft, directKeys, draftImages, fillParts, leadCard, notesOf, partNamed, partOf, pickProblems, type Draft } from './draft';
import { isComponent, isGroup } from './garment-role';
import { LEGACY_LAYOUTS } from './legacy-layouts';

const commute = LEGACY_LAYOUTS[0];
const still = (id: string, over: object = {}) => ({ id, kind: '静物', front: true, logo: false, ...over });

describe('liners and group photos (10-15)', () => {
  it('a liner or an accessory photographed on its own is not the garment', () => {
    expect(isComponent({ role: '内胆' })).toBe(true);
    expect(isComponent({ role: '配件' })).toBe(true);
    expect(isComponent({ detail: '抓绒内胆' })).toBe(true);
    expect(isComponent({ role: '主体', detail: '袖口' })).toBe(false);
    expect(isComponent({})).toBe(false); // sorted before 10-16
  });
  it('a photo of several people or several colours is a group photo', () => {
    expect(isGroup({ person: '多人' })).toBe(true);
    expect(isGroup({ person: '男女' })).toBe(true);
    expect(isGroup({ colorsSeen: ['白色', '军绿'] })).toBe(true);
    expect(isGroup({ person: '男', colorsSeen: ['白色'] })).toBe(false);
  });
});

describe('each colour its own images', () => {
  const colors = [{ name: '黑色', pick: 'M3' }, { name: '白色', pick: 'M17' }, { name: '军绿', pick: 'M17' }, { name: '藏青', pick: null }];
  it('a group photo chosen for two colours gives the second its own key', () => {
    expect(colorKeys(colors)).toEqual(['M3', 'M17', 'M17-2', null]);
  });
  it('refuses a liner, and one single-garment photo for two colours; a group photo may be shared', () => {
    const images = [{ id: 'M3', role: '内胆' }, { id: 'M17', person: '多人' }];
    expect(pickProblems(colors, images)).toEqual([expect.stringContaining('「黑色」选的是单独拍的内胆')]);
    const single = [{ id: 'M3' }, { id: 'M17', person: '男' }];
    expect(pickProblems(colors, single)).toEqual([expect.stringContaining('「白色」「军绿」用了同一张衣服图（M17）')]);
  });
  it('the price counts each colour of a group photo as its own images, none of them free', () => {
    const d: Draft = { ...defaultDraft(DEMO_MATERIAL, commute) };
    const shared = { ...d, colors: d.colors.map((c, k) => k === 1 ? { ...c, pick: d.colors[0].pick } : c) };
    const keys = colorKeys(shared.colors);
    const slots = draftImages(shared, commute, new Set()).map(i => i.slot);
    expect(slots).toContain(`product:${keys[0]}`);
    expect(slots).toContain(`product:${keys[1]}`);
    expect(new Set(slots).size).toBe(slots.length);
    const images = [still(shared.colors[0].pick!, { person: '多人' }), ...shared.colors.slice(2).map(c => still(c.pick!))];
    expect(directKeys(shared.colors, images)).not.toContain(keys[0]);
    expect(directKeys(shared.colors, images)).not.toContain(keys[1]);
    expect(directKeys(shared.colors, images)).toContain(keys[2]);
  });
  it('the page shows the colour problems in red when it has the sorted images, and passes old plans without them', () => {
    const d = defaultDraft(DEMO_MATERIAL, commute), liner = d.colors[0].pick!;
    expect(checkDraft(d, commute, [{ id: liner, role: '内胆' }]).red.join()).toContain('内胆');
    expect(checkDraft(d, commute).red.join()).not.toContain('内胆');
  });
});

describe('taped seams want a photo of the tape', () => {
  it('a taped-seam point is a close-up of the tape, not of the seam outside', () => {
    expect(partOf({ text: '接缝全压胶', part: '接缝' })).toBe('压胶条');
    expect(partOf({ text: '全压胶工艺' })).toBe('压胶条');
    expect(partOf({ text: '接缝全压胶', part: '内侧压胶' })).toBe('内侧压胶');
    expect(partOf({ text: '贴腕袖口', part: '袖口' })).toBe('袖口');
  });
  it('with only a photo of the outer seam, the card is drawn another way', () => {
    const d0 = defaultDraft(DEMO_MATERIAL, commute);
    const taped = { id: 'tape', text: '接缝全压胶', note: '', type: '做工' as const, concept: null, group: '必打' as const, source: '素材' as const, kind: '衣服' as const, on: true, proof: 'part', part: '接缝', why: '', evidence: '', from: [], score: 1 };
    const i = d0.slots.findIndex(s => s.cells.length);
    const d: Draft = { ...d0, points: [...d0.points, taped], parts: [...d0.parts, { part: '接缝', pick: 'M50' }],
      slots: d0.slots.map((s, k) => k === i ? { ...s, cells: [{ point: 'tape', proof: 'part' }, ...s.cells.slice(1)] } : s) };
    expect(fillParts(d, []).slots[i].cells[0].proof).not.toBe('part');
    const withTape = { ...d, parts: [...d.parts, { part: '压胶条', pick: 'M51' }] };
    expect(fillParts(withTape, []).slots[i].cells[0].proof).toBe('part');
  });
});

describe('a heading that names a part', () => {
  const d = defaultDraft(DEMO_MATERIAL, commute);
  const id = (text: string) => d.points.find(p => p.text === text)!.id;
  it('reads the part a heading names, and nothing in words that only look like one', () => {
    expect(partNamed('帽围自由调节')).toBe('帽');
    expect(partNamed('立领挡风')).toBe('领');
    expect(partNamed('引领潮流')).toBeUndefined();
    expect(partNamed('细节经得起看')).toBeUndefined();
  });
  it('finds the card of that part to draw first', () => {
    const cells = [{ point: id('利落立领') }, { point: id('双侧拉链口袋') }, { point: id('贴腕袖口') }];
    expect(leadCard(d, '袖口大小随意调', cells)).toBe(2);
    expect(leadCard(d, '细节经得起看', cells)).toBe(-1);
    expect(leadCard(d, '帽围自由调节', cells)).toBe(-1);
  });
  it('warns when no card shows the part the heading names', () => {
    const i = d.slots.findIndex(s => s.task === '细节');
    const off = { ...d, slots: d.slots.map((s, k) => k === i ? { ...s, title: '帽围自由调节' } : s) };
    expect(notesOf(off, i, commute).join()).toContain('大标题讲「帽」');
    expect(notesOf(d, i, commute).join()).not.toContain('大标题讲');
  });
});
