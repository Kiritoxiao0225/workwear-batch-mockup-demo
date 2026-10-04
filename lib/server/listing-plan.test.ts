import { describe, expect, it } from 'vitest';
import { parsePlan, planRequest } from './listing-plan';
import { LISTING_LAYOUTS, rolesFor, shapeOf } from '../listing/layouts';

const images = [
  { id: 'M1', shape: '1:1' as const }, { id: 'M2', shape: '1:1' as const }, { id: 'M3', shape: '其他' as const }, { id: 'M4', shape: '1:1' as const },
];
const slot = (n: number, colors: string[]) => ({ n, role: '首图', title: '轻盈抗造工作服', colors });
const plan = (over: Record<string, unknown> = {}) => JSON.stringify({
  assets: [
    { id: 'M1', role: '主图' }, { id: 'M2', role: 'SKU', color: '黑色' }, { id: 'M3', role: '主图' }, { id: 'M4', role: '不用' },
  ],
  product: { name: '立领工作外套', garment: ['立领'], colors: [{ name: '黑色', sku: 'M2' }] },
  sellingPoints: [{ id: 'P1', text: '三防面料', evidence: ['M1'] }],
  main: { square: [slot(1, ['黑色'])] },
  sku: { tag: '男女同款', items: [{ color: '黑色', sku: 'M2' }] },
  ...over,
});

describe('listing plan', () => {
  it('turns a non-1:1/3:4 image the model called a main image into a detail slice', () => {
    const { plan: parsed, corrected, problems } = parsePlan(plan(), images);
    expect(parsed.assets.find(a => a.id === 'M3')?.role).toBe('详情');
    expect(corrected).toEqual(['M3 主图→详情（形状不是 1:1 或 3:4）']);
    expect(problems).toEqual([]);
  });

  it('stops on colours that do not point at a SKU image, unknown colours and too many colours', () => {
    const { problems } = parsePlan(plan({
      product: { name: 'x', garment: ['立领'], colors: [{ name: '黑色', sku: 'M1' }] },
      main: { square: [slot(1, ['大红']), slot(2, ['黑色', '黑色', '黑色', '黑色', '黑色'])] },
    }), images);
    expect(problems).toContain('颜色「黑色」对应的 M1 不是 SKU 图');
    expect(problems).toContain('第 1 张图用了不存在的颜色「大红」');
    expect(problems).toContain('第 2 张图用了 5 种颜色，最多 4 种');
  });

  it('flags an unsorted image and a cited image marked unused', () => {
    const { problems } = parsePlan(plan({
      assets: [{ id: 'M1', role: '主图' }, { id: 'M2', role: 'SKU' }, { id: 'M3', role: '详情' }],
      sellingPoints: [{ id: 'P1', text: '三防面料', evidence: ['M4'] }],
    }), images);
    expect(problems).toContain('M4 没有分类');
    const unused = parsePlan(plan({ sellingPoints: [{ id: 'P1', text: '三防面料', evidence: ['M4'] }] }), images).problems;
    expect(unused).toContain('M4 标为不用却被引用');
  });

  it('rejects output that is not the agreed JSON', () => {
    expect(() => parsePlan('不是 JSON', images)).toThrow('不是完整的 JSON');
    expect(() => parsePlan(JSON.stringify({ assets: [] }), images)).toThrow();
  });

  it('asks only for the images the user chose, in buying order', () => {
    expect(rolesFor(3)).toEqual(['首图', '功能', '收口']);
    expect(rolesFor(0)).toEqual([]);
    const request = planRequest({ views: [{ text: '【M1】形状：1:1', dataUrl: 'data:image/jpeg;base64,' }],
      counts: { square: 2, portrait: 0, poster: 0 }, layout: LISTING_LAYOUTS[0], model: 'gpt-6.1-sol' });
    const task = (request.messages[1].content as { type: string; text?: string }[])[0].text!;
    expect(task).toContain('1:1 主图 2 张');
    expect(task).toContain('不出 3:4 主图');
    expect(task).toContain(LISTING_LAYOUTS[0].name);
    expect(shapeOf(1440, 1920)).toBe('3:4');
    expect(shapeOf(1000, 1792)).toBe('其他');
  });
});
