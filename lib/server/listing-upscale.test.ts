import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { upscaleListingImage } from './listing-upscale';

const image = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#d99a2b' } }).png().toBuffer();

describe('listing upscale', () => {
  it('scales the enhanced image to the platform size', async () => {
    const out = await upscaleListingImage(await image(880, 1184), 'portrait', async b => sharp(b).resize(1760, 2368).png().toBuffer());
    expect(out.enhanced).toBe(true);
    expect(await sharp(out.bytes).metadata()).toMatchObject({ width: 1440, height: 1920, format: 'jpeg' });
  });

  it('still delivers the platform size when MediaKit fails', async () => {
    const out = await upscaleListingImage(await image(832, 1248), 'long', async () => { throw new Error('down'); });
    expect(out.enhanced).toBe(false);
    expect(await sharp(out.bytes).metadata()).toMatchObject({ width: 1440, height: 2160 });
  });
});
