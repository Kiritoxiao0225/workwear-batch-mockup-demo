import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { markPlain, ON_WHITE, whiteBorder } from './listing-plain';

/** A dark garment in the middle of a background. */
const shot = (background: string) => sharp({ create: { width: 600, height: 800, channels: 3, background } })
  .composite([{ input: { create: { width: 360, height: 560, channels: 3, background: '#202020' } }, left: 120, top: 120 }]).jpeg().toBuffer();

describe('is a still life on white (10-19)', () => {
  it('tells a white or transparent background from a scene', async () => {
    expect(await whiteBorder(await shot('#ffffff'))).toBeGreaterThan(ON_WHITE);
    expect(await whiteBorder(await shot('#f3f3f1'))).toBeGreaterThan(ON_WHITE);
    expect(await whiteBorder(await shot('#a0a0a0'))).toBeLessThan(ON_WHITE);
    const cut = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect(await whiteBorder(cut)).toBeGreaterThan(ON_WHITE);
  });
  it('marks only the still lifes that could be used as they are', async () => {
    const images = [
      { id: 'M1', kind: '静物', front: true, logo: false }, { id: 'M2', kind: '3D渲染', front: true, logo: false },
      { id: 'M3', kind: '模特实拍', front: true, logo: false }, { id: 'M4', kind: '静物', front: true, logo: true },
    ];
    const marked = await markPlain(images, [{ id: 'M1', bytes: await shot('#ffffff') }, { id: 'M2', bytes: await shot('#8a7a6a') }, { id: 'M3', bytes: await shot('#8a7a6a') }, { id: 'M4', bytes: await shot('#8a7a6a') }]);
    expect(marked.map(i => (i as { plain?: boolean }).plain)).toEqual([true, false, undefined, undefined]);
  });
});
