import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { brandImage, pasteShopLogo } from './listing-corner';

const plain = (w: number, h: number, color: string) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
/** A LOGO of three navy squares with gaps on a transparent ground. */
const logo = async (color = '#1f2a44', ground = { r: 0, g: 0, b: 0, alpha: 0 }) => {
  const square = await sharp({ create: { width: 80, height: 80, channels: 4, background: color } }).png().toBuffer();
  return sharp({ create: { width: 400, height: 120, channels: 4, background: ground } }).composite([20, 160, 300].map(left => ({ input: square, left, top: 20 }))).png().toBuffer();
};
const at = async (bytes: Buffer, x: number, y: number) => [...(await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer())];

describe('pasteShopLogo', () => {
  it('puts the LOGO 4 % from the left and 3.5 % from the top, at most a fifth of the width, the same size and format', async () => {
    const out = await pasteShopLogo(await plain(1440, 1920, '#f5f5f5'), await brandImage(await logo()));
    expect(await sharp(out).metadata()).toMatchObject({ width: 1440, height: 1920, format: 'jpeg' });
    // Trimmed to 360×80 and scaled to 288 wide: its first square is 58–122 × 50–114, the gap after it is clear.
    expect((await at(out, 80, 80))[2]).toBeLessThan(110);
    expect((await at(out, 140, 80))[0]).toBeGreaterThan(230);
    expect((await at(out, 400, 80))[0]).toBeGreaterThan(230);
  });

  it('keeps its own colours on a light plain corner, goes white on a dark one and dark on a coloured one', async () => {
    const mark = await brandImage(await logo());
    const light = await at(await pasteShopLogo(await plain(1440, 1440, '#f5f5f5'), mark), 80, 80);
    expect(light[2] - light[0]).toBeGreaterThan(20); // still navy
    expect((await at(await pasteShopLogo(await plain(1440, 1440, '#111111'), mark), 80, 80))[0]).toBeGreaterThan(240);
    expect((await at(await pasteShopLogo(await plain(1440, 1440, '#e8862a'), mark), 80, 80))[0]).toBeLessThan(50);
  });

  it('a busy corner gets a soft plate under the LOGO; a LOGO that is a solid block keeps its colours and needs none', async () => {
    const stripes = await sharp({ create: { width: 1440, height: 1440, channels: 3, background: '#ffffff' } })
      .composite(Array.from({ length: 24 }, (_, i) => ({ input: { create: { width: 1440, height: 6, channels: 3 as const, background: '#000000' } }, left: 0, top: i * 12 }))).jpeg().toBuffer();
    const plated = await pasteShopLogo(stripes, await brandImage(await logo()));
    expect((await at(plated, 140, 72))[0]).toBeGreaterThan(150); // a black stripe row, lightened by the plate
    const block = await brandImage(await sharp({ create: { width: 300, height: 100, channels: 3, background: '#cc0000' } }).png().toBuffer());
    const red = await at(await pasteShopLogo(await plain(1440, 1440, '#111111'), block), 100, 70);
    expect(red[0]).toBeGreaterThan(180); expect(red[1]).toBeLessThan(60);
  });
});

describe('brandImage', () => {
  it('takes the white off a LOGO uploaded on white, and trims to it', async () => {
    const onWhite = await sharp(await logo('#1f2a44', { r: 255, g: 255, b: 255, alpha: 1 })).flatten({ background: '#ffffff' }).jpeg().toBuffer();
    const kept = await brandImage(onWhite), meta = await sharp(kept).metadata();
    expect([meta.hasAlpha, Math.abs(meta.width! - 360) < 6, Math.abs(meta.height! - 80) < 6]).toEqual([true, true, true]);
    const { data } = await sharp(kept).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // The gap between two squares is see-through.
    expect(data[(40 * meta.width! + 110) * 4 + 3]).toBe(0);
  });

  it('refuses something that is not an image', async () => {
    await expect(brandImage(Buffer.from('not an image'))).rejects.toThrow('LOGO 读不出来');
  });
});
