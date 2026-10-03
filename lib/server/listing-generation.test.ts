import { describe, expect, it } from 'vitest';
import { planJobs } from './listing-generation';
import { mainPrompt, skuPrompt } from './listing-prompts';
import { LISTING_LAYOUTS } from '../listing/layouts';

const slot = (n: number, colors: string[], title = `标题${n}`) => ({ n, role: '', points: [], title, subtitle: '副', bullets: ['要点一', '要点二'], scene: '水珠演示防泼水', colors });
const stored = {
  plan: {
    assets: [], sellingPoints: [],
    product: { name: '外套', category: '', audience: '', fabric: '', garment: ['立领'], colors: [{ name: '落霞橙', hex: '#d99a2b', sku: 'M30' }, { name: '黑色', hex: '#111', sku: 'M31' }, { name: '北欧蓝', hex: '#234', sku: 'M32' }] },
    main: { square: [slot(1, ['落霞橙']), slot(2, ['落霞橙', '黑色', '北欧蓝']), slot(3, ['不存在的颜色'])], portrait: [slot(1, ['落霞橙'])], poster: [slot(1, ['落霞橙'])] },
    sku: { tag: '男女同款', fabric: '三防面料', items: [] },
  },
  corrected: [], problems: [], model: 'm', images: [],
};

describe('listing jobs', () => {
  it('makes product images first, copies the first SKU image, and builds multi-colour images on SKU images', () => {
    const jobs = planJobs(stored as never, null, { square: 3, portrait: 0, poster: 1 });
    expect(jobs.map(j => j.slot)).toEqual(['product:M30', 'product:M31', 'product:M32', 'sku:M30', 'sku:M31', 'sku:M32', 'square:1', 'square:2', 'square:3', 'poster:1']);
    const by = new Map(jobs.map(j => [j.slot, j]));
    expect(by.get('sku:M30')!.depends).toEqual(['product:M30']);
    expect(by.get('sku:M31')!.depends).toEqual(['product:M31', 'sku:M30']);
    expect(by.get('square:1')!.depends).toEqual(['product:M30']);
    expect(by.get('square:2')!.depends).toEqual(['sku:M30', 'sku:M31', 'sku:M32']);
    expect(by.get('square:2')!.multi).toBe(true);
    // An unknown colour falls back to the main colour instead of guessing.
    expect(by.get('square:3')!.depends).toEqual(['product:M30']);
    expect(jobs.filter(j => j.multi)).toHaveLength(1);
  });

  it('uses the user words and colour names, and respects the chosen counts', () => {
    const jobs = planJobs(stored as never, { colors: [{ sku: 'M31', name: '经典黑' }], slots: { 'square:1': { title: '改过的标题', subtitle: '', bullets: [] } } }, { square: 2, portrait: 1, poster: 0 });
    const square1 = jobs.find(j => j.slot === 'square:1')!.input as { slot: { title: string; bullets: string[]; role: string } };
    expect(square1.slot.title).toBe('改过的标题');
    expect(square1.slot.bullets).toEqual([]);
    expect(square1.slot.role).toBe('首图');
    expect((jobs.find(j => j.slot === 'square:2')!.input as { slot: { colors: string[]; role: string } }).slot).toMatchObject({ colors: ['落霞橙', '经典黑', '北欧蓝'], role: '收口' });
    expect(jobs.some(j => j.slot.startsWith('poster'))).toBe(false);
    expect(jobs.filter(j => j.slot.startsWith('portrait'))).toHaveLength(1);
  });

  it('writes only the given words and forbids invented copy', () => {
    const layout = LISTING_LAYOUTS[1];
    const prompt = mainPrompt({ layout, slot: { kind: 'square', n: 2, total: 5, role: '收口', title: '团队穿出同一范', subtitle: '', bullets: ['六色可选'], scene: '', colors: [] },
      used: [{ name: '落霞橙', hex: '#d99a2b' }, { name: '黑色', hex: '#111' }], all: [{ name: '落霞橙', hex: '#d99a2b' }, { name: '黑色', hex: '#111' }], fromSku: true, garment: ['立领'] });
    expect(prompt).toContain('画面上的文字只有这几句：主标题「团队穿出同一范」，要点「六色可选」');
    expect(prompt).toContain('不要自己补充文案');
    expect(prompt).toContain('图1=落霞橙，图2=黑色');
    expect(prompt).toContain(layout.roles.收口);
    const sku = skuPrompt({ layout, color: '黑色', anchor: '落霞橙', tag: '男女同款', fabric: '', garment: ['立领'] });
    expect(sku).toContain('图2：同一套 SKU 图里已经做好的「落霞橙」那张');
    expect(sku).not.toContain('面料小图下方的小字');
  });
});
