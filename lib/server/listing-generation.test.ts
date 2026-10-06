import { describe, expect, it } from 'vitest';
import { planJobs } from './listing-generation';
import { mainPrompt, skuPrompt } from './listing-prompts';
import { LISTING_LAYOUTS } from '../listing/layouts';
import type { MainWords, StoredPlan } from './listing-store';

const slot = (role: MainWords['role'], colors: string[], title = `标题-${role}`): MainWords => ({ role, title, subtitle: '副', bullets: ['要点一', '要点二'], scene: '水珠演示防泼水', colors });
const stored: StoredPlan = {
  garment: ['立领'], colors: [{ name: '落霞橙', hex: '#d99a2b', sku: 'M30' }, { name: '黑色', hex: '#111', sku: 'M31' }, { name: '北欧蓝', hex: '#234', sku: 'M32' }],
  main: { square: [slot('首图', ['落霞橙']), slot('功能', ['不存在的颜色']), slot('收口', ['落霞橙', '黑色', '北欧蓝'])], portrait: [slot('首图', ['落霞橙'])], poster: [slot('海报', ['落霞橙'])] },
  sku: { tag: '男女同款', fabric: '三防面料' }, extra: [{ color: '北欧蓝', layout: 'commute-split' }], direct: ['M31'], images: [], model: 'm',
};

describe('listing jobs', () => {
  it('makes product images first, copies the main colour\'s SKU image, and builds multi-colour images on SKU images', () => {
    const jobs = planJobs(stored);
    expect(jobs.map(j => j.slot)).toEqual(['product:M30', 'product:M31', 'product:M32', 'sku:M30', 'sku:M31', 'sku:M32', 'square:1', 'square:2', 'square:3', 'portrait:1', 'poster:1',
      'square:1+M32', 'portrait:1+M32', 'poster:1+M32']);
    const by = new Map(jobs.map(j => [j.slot, j]));
    expect(by.get('product:M31')).toMatchObject({ free: true, input: { direct: true } });
    expect(by.get('sku:M31')!.depends).toEqual(['product:M31', 'sku:M30']);
    expect(by.get('square:3')).toMatchObject({ multi: true, depends: ['sku:M30', 'sku:M31', 'sku:M32'] });
    // An unknown colour falls back to the main colour instead of guessing.
    expect(by.get('square:2')!.depends).toEqual(['product:M30']);
    expect(by.get('square:1+M32')).toMatchObject({ depends: ['product:M32'], input: { layout: 'commute-split', skus: ['M32'], slot: { role: '首图', colors: ['北欧蓝'] } } });
  });

  it('remakes only one extra set when one is added later', () => {
    expect(planJobs(stored, 'M32').map(j => j.slot)).toEqual(['square:1+M32', 'portrait:1+M32', 'poster:1+M32']);
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
