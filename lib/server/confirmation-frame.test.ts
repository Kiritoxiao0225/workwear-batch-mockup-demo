import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CONFIRMATION_FRAME, CONFIRMATION_OUTPUT } from '@/lib/confirmation-frame';
import { renderConfirmationFrame } from './confirmation-frame';

const views = [
  { face: 'front', crop: { x: 0, y: 0, width: 0.5, height: 1 } },
  { face: 'back', crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
];
const template = () => sharp({ create: { width: CONFIRMATION_OUTPUT.width, height: CONFIRMATION_OUTPUT.height, channels: 3, background: '#152e49' } }).png().toBuffer();
const shirts = () => sharp(Buffer.from('<svg width="160" height="100"><rect x="20" y="10" width="40" height="80" fill="#ff0000"/><rect x="100" y="10" width="40" height="80" fill="#00ff00"/></svg>')).png().toBuffer();

describe('confirmation frame proof', () => {
  it('keeps front/back in order at the same scale and preserves every pixel outside the garment area', async () => {
    const frame = await template();
    const output = await renderConfirmationFrame(await shirts(), frame, [...views].reverse());
    const source = await sharp(frame).resize(CONFIRMATION_OUTPUT.width, CONFIRMATION_OUTPUT.height).removeAlpha().raw().toBuffer();
    const { data: pixels, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([3252, 2301]);
    const area = Object.fromEntries(Object.entries(CONFIRMATION_FRAME.garmentArea).map(([key, value]) => [key, value * CONFIRMATION_OUTPUT.scale]));
    const bounds = [ { x0: info.width, x1: -1, y0: info.height, y1: -1 }, { x0: info.width, x1: -1, y0: info.height, y1: -1 } ];
    let changedOutside = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 3;
      if (x < area.left || x >= area.left + area.width || y < area.top || y >= area.top + area.height) {
        if (pixels[offset] !== source[offset] || pixels[offset + 1] !== source[offset + 1] || pixels[offset + 2] !== source[offset + 2]) changedOutside++;
      }
      const color = pixels[offset] > 240 && pixels[offset + 1] < 15 ? 0 : pixels[offset + 1] > 240 && pixels[offset] < 15 ? 1 : -1;
      if (color >= 0) { const b = bounds[color]; b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); }
    }
    expect(changedOutside).toBe(0);
    expect(bounds[0].x1).toBeLessThan(info.width / 2);
    expect(bounds[1].x0).toBeGreaterThan(info.width / 2);
    expect(bounds[0].y1).toBe(bounds[1].y1);
    expect(bounds[0].x1 - bounds[0].x0).toBe(bounds[1].x1 - bounds[1].x0);
    expect((bounds[0].x1 - bounds[0].x0 + 1) / (bounds[0].y1 - bounds[0].y0 + 1)).toBeCloseTo(0.5, 2);
  });
  it('centers a front-only image without inventing a back or removing an opaque white garment', async () => {
    const garment = await sharp({ create: { width: 40, height: 80, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const png = await renderConfirmationFrame(garment, await template(), [{ face: 'front', crop: { x: 0, y: 0, width: 1, height: 1 } }]);
    const { data: pixels, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => { const offset = (y * CONFIRMATION_OUTPUT.scale * info.width + x * CONFIRMATION_OUTPUT.scale) * 3; return [...pixels.subarray(offset, offset + 3)]; };
    expect(pixel(542, 300)).toEqual([255, 255, 255]);
    expect(pixel(200, 300)).toEqual([21, 46, 73]);
    expect(pixel(884, 300)).toEqual([21, 46, 73]);
  });
  it('rejects missing/repeated faces, empty images and a mismatched frame', async () => {
    const garment = await shirts(); const frame = await template();
    await expect(renderConfirmationFrame(garment, frame, [views[1]])).rejects.toThrow('必须有正面');
    await expect(renderConfirmationFrame(garment, frame, [views[0], views[0]])).rejects.toThrow('不能重复视图');
    const empty = await sharp({ create: { width: 160, height: 100, channels: 4, background: '#00000000' } }).png().toBuffer();
    await expect(renderConfirmationFrame(empty, frame, views)).rejects.toThrow('完全透明');
    await expect(renderConfirmationFrame(garment, garment, views)).rejects.toThrow('底框尺寸应为');
  });
});
