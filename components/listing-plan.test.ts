import { describe, expect, it } from 'vitest';
import type { Materials } from '@/lib/listing/api-types';
import { DEMO_MATERIAL } from '@/lib/listing/demo/material';
import { draftImages, reusedSlots } from '@/lib/listing/draft';
import { BUILT_IN_LAYOUTS } from '@/lib/listing/templates';
import { startDraft } from './listing-plan';

const M1 = BUILT_IN_LAYOUTS.find(l => l.id === 'M1')!;
const material = (variant?: number): Materials => ({
  category: DEMO_MATERIAL.category, categoryWhy: DEMO_MATERIAL.categoryWhy, checks: DEMO_MATERIAL.checks, titles: DEMO_MATERIAL.titles,
  sorted: { images: [], colors: [], points: DEMO_MATERIAL.points, notes: [] },
  chosen: { colors: DEMO_MATERIAL.colors.map(c => ({ ...c, candidates: [] })), parts: DEMO_MATERIAL.parts.map(p => ({ ...p, candidates: [] })) },
  duplicates: [], images: [], look: { master: 'M1', place: '写字楼', why: '' }, ...(variant ? { variant } : {}),
});

describe('「再出一套」 (10-18: one upload, several masters and points)', () => {
  it('the copies of one product take its points in turn, and a copy keeps its own picks', () => {
    const sells = [1, 2].map(v => startDraft(material(v), M1).scene!.sell);
    expect(new Set(sells).size).toBe(2);
    expect(startDraft(material(1), M1).scene).toEqual(startDraft(material(1), M1).scene);
    expect(startDraft(material(1), M1).seed).toBe(1);
    expect(startDraft(material(), M1).seed).toBeUndefined();
  });
  it('a copy\'s carried-over white images and cast are free while the colour and the model stay the same', () => {
    const d = startDraft(material(1), M1), key = d.colors[0].pick!;
    const reuse = { colors: { [key]: d.colors[0].name }, model: d.model, slots: [`product:${key}`, 'cast'] };
    const items = draftImages(d, M1, new Set(), new Set(), reusedSlots(d, reuse));
    expect(items.find(i => i.slot === `product:${key}`)).toMatchObject({ free: true, label: '白底产品图（沿用）' });
    expect(items.find(i => i.slot === 'cast')).toMatchObject({ free: true });
    expect(reusedSlots({ ...d, colors: [{ ...d.colors[0], name: '改了名' }, ...d.colors.slice(1)] }, reuse).has(`product:${key}`)).toBe(false);
    expect(reusedSlots({ ...d, model: { lead: d.model.lead === '男' ? '女' : '男' } }, reuse).has('cast')).toBe(false);
  });
});

describe('「再出一套」 cover (11-01): who is on it and an 一体 jacket worn open, picked in the dialog', () => {
  const oneBody = (extra: Partial<Materials>): Materials => ({ ...material(1), wear: { type: '一体', versions: [], why: '' } as unknown as Materials['wear'], ...extra });
  it("puts the dialog's choice on the new plan; none leaves the master's own", () => {
    expect(startDraft(oneBody({ cover: { people: '男女', open: true } }), M1)).toMatchObject({ coverPeople: '男女', wear: { type: '一体', open: true } });
    expect(startDraft(oneBody({}), M1).coverPeople).toBeUndefined();
  });
  it("keeps the first product's inside photos and box, the dialog's 敞开 or 拉上 on top", () => {
    const reuse = { colors: {}, model: null, slots: [], wear: { type: '一体' as const, box: false, open: true, insides: { M1: 'X2' } } };
    expect(startDraft(oneBody({ reuse }), M1).wear).toEqual({ type: '一体', box: false, open: true, insides: { M1: 'X2' } });
    expect(startDraft(oneBody({ reuse, cover: { open: false } }), M1).wear).toMatchObject({ open: false, insides: { M1: 'X2' } });
    // Another type read now: the first product's choices are not carried.
    expect(startDraft(oneBody({ reuse: { ...reuse, wear: { type: '薄款' as const } } }), M1).wear).toEqual({ type: '一体', box: true });
  });
});
