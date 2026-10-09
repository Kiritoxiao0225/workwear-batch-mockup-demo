import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { maskOf, pasteBack } from './listing-edit';

const solid = (w: number, h: number, background: string) => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
const pixel = async (image: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels)];
};

describe('画板 edits', () => {
  it('the mask is transparent inside the box only', async () => {
    const mask = await maskOf([[25, 25, 50, 50]], 100, 100);
    expect((await pixel(mask, 50, 50))[3]).toBe(0);
    expect((await pixel(mask, 5, 5))[3]).toBe(255);
  });
  it('the redrawn picture is kept only inside the box, the rest stays the original', async () => {
    // The generator answers at another size; the original is the 1440 main image.
    const out = await pasteBack(await solid(400, 400, '#ffffff'), await solid(256, 256, '#ff0000'), [[25, 25, 50, 50]]);
    expect((await sharp(out).metadata()).format).toBe('jpeg');
    const [r, g] = await pixel(out, 200, 200);
    expect(r).toBeGreaterThan(240); expect(g).toBeLessThan(15);
    for (const [x, y] of [[10, 10], [390, 390], [200, 20], [20, 200]]) expect((await pixel(out, x, y)).every(v => v > 240)).toBe(true);
  });
});
