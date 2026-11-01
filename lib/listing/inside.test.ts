import { describe, expect, it } from 'vitest';
import { heatPoint, insideFor, insidePhoto } from './inside';
import { openLine } from './wear';

// An 一体绒 jacket as sorted: two colours, close-ups of the inside, a detail page with the inside on it.
const images = [
  { id: 'M1', kind: '静物', color: '暗夜紫', detail: '' },
  { id: 'M2', kind: '静物', color: '红色', detail: '' },
  { id: 'M3', kind: '细节特写', color: '暗夜紫', detail: '内里' },
  { id: 'M4', kind: '模特实拍', color: '暗夜紫', detail: '里绒' },
  { id: 'M5', kind: '详情页', color: '红色', detail: '内里' },
  { id: 'M6', kind: '细节特写', color: '暗夜紫', detail: '内里', same: 'M3' },
  { id: 'M7', kind: '细节特写', color: '红色', detail: '口袋' },
];
const draft = (insides?: Record<string, string>) => ({ colors: [{ name: '暗夜紫', hex: '', pick: 'M1' }, { name: '红色', hex: '', pick: 'M2' }], wear: { type: '一体' as const, box: true, insides } });

describe('the inside of an 一体 jacket (10-29)', () => {
  it("takes the colour's own close-up of its inside, never a detail page or a copy", () => {
    expect(insideFor(images, draft(), 'M1')).toBe('M3');
    // Red has its inside only on a detail page: none, its box left empty.
    expect(insideFor(images, draft(), 'M2')).toBeNull();
  });
  it("never lends one colour's inside to another, unless the photos say no colour of the product", () => {
    expect(insidePhoto(images, '红色', ['暗夜紫', '红色'])).toBeNull();
    expect(insidePhoto([{ id: 'X', kind: '细节特写', color: '', detail: '内胆' }], '红色', ['暗夜紫', '红色'])).toBe('X');
  });
  it("keeps the plan's choice, '' leaving the box empty", () => {
    expect(insideFor(images, draft({ M2: 'M4' }), 'M2')).toBe('M4');
    expect(insideFor(images, draft({ M1: '' }), 'M1')).toBeNull();
  });
  it('puts the heat badge on the open cover only for a heating point of the material', () => {
    const p = (text: string, on = true, source = '素材') => ({ text, note: '', on, source: source as '素材' });
    expect(heatPoint([p('石墨烯蓄热恒温')])).toBe(true);
    expect(heatPoint([p('石墨烯蓄热恒温', false), p('防泼水')])).toBe(false);
    expect(heatPoint([{ ...p('远红外发热'), source: '品类' as never }])).toBe(false);
    expect(openLine(3, true)).toContain('参考图3');
    expect(openLine(3, true)).toContain('橙色');
    expect(openLine(3, false)).not.toContain('橙色');
  });
  it('opens on the front panel, not the back lining (11-01, 8826)', () => {
    expect(openLine(3, false)).toContain('后背中间那块里布被身体挡住');
    expect(openLine(3, false, false, true)).toContain('裁下来的前片里面');
    expect(openLine(3, false, false, false)).not.toContain('裁下来');
  });
});
