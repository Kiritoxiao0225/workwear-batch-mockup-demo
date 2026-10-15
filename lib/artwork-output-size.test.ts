import { describe, expect, it } from 'vitest';
import { drawSize, outputSize, upscalePasses } from './artwork-output-size';

describe('artwork output size', () => {
  it('draws at about one megapixel with the image model sizes', () => {
    expect(drawSize(1)).toEqual({ width: 1024, height: 1024 });
    expect(drawSize(2 / 3)).toEqual({ width: 832, height: 1248 });
    expect(drawSize(3 / 4)).toEqual({ width: 880, height: 1184 });
    expect(drawSize(3 / 2)).toEqual({ width: 1248, height: 832 });
  });
  it('enlarges to a 2048 or 4096 long edge', () => {
    expect(outputSize('2:3', '2K')).toEqual({ width: 1365, height: 2048 });
    expect(outputSize('1:1', '4K')).toEqual({ width: 4096, height: 4096 });
    expect(outputSize('4:3', '4K')).toEqual({ width: 4096, height: 3044 });
  });
  it('follows the first reference image for 原比例, or leaves it to the model without one', () => {
    expect(outputSize('original', '1K', { width: 1080, height: 1620 })).toEqual({ width: 832, height: 1248 });
    expect(outputSize('original', '2K', null)).toBeNull();
  });
  it('keeps extreme references within 3:1', () => {
    expect(drawSize(10)).toEqual(drawSize(3));
  });
  it('needs one upscale pass for 2K and two for 4K', () => {
    expect([upscalePasses('1K'), upscalePasses('2K'), upscalePasses('4K')]).toEqual([0, 1, 2]);
  });
});
