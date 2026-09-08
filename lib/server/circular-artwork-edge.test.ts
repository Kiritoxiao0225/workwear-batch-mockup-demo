import sharp from 'sharp';
import { describe, it, expect } from 'vitest';
import { refineCircularArtworkEdge } from './circular-artwork-edge';

async function badge({ hole = false, ellipse = false, broken = false, whiteRim = false } = {}) {
  const width = 200, radius = 77.35, cx = 98.6, cy = 100.2;
  const pixels = Buffer.alloc(width * width * 4), truth = Buffer.alloc(pixels.length);
  const foreground = whiteRim ? [252, 252, 252] : [64, 59, 108];
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const d = Math.hypot((x - cx) * (ellipse ? 1.12 : 1), y - cy), i = (y * width + x) * 4;
    const a = Math.max(0, Math.min(1, radius + 0.5 - d));
    const inner = d < radius - 5;
    const color = inner ? [255, 255, 255] : foreground;
    if (hole && d < 12) continue;
    if (broken && x > cx && Math.abs(y - cy) < 5 && d > radius - 5) continue;
    const oldAlpha = Math.max(0, Math.min(1, (a - 0.08) / 0.25)); // thresholded mask leaves a pale fringe
    for (let c = 0; c < 3; c++) {
      const composite = color[c] * a + 255 * (1 - a);
      pixels[i + c] = oldAlpha ? Math.round(Math.max(0, (composite - 255 * (1 - oldAlpha)) / oldAlpha)) : 0;
      truth[i + c] = color[c];
    }
    pixels[i + 3] = Math.round(oldAlpha * 255); truth[i + 3] = Math.round(a * 255);
  }
  return { bytes: await sharp(pixels, { raw: { width, height: width, channels: 4 } }).png().toBuffer(), pixels, truth, width, radius, cx, cy };
}

describe('circular badge outer edge repair', () => {
  it('removes matte fringe on a dark background and preserves every inner pixel', async () => {
    const source = await badge();
    const result = await refineCircularArtworkEdge(source.bytes);
    expect(result.report.applied).toBe(true);
    const after = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
    let oldError = 0, newError = 0, innerPixels = 0;
    for (let y = 0; y < source.width; y++) for (let x = 0; x < source.width; x++) {
      const d = Math.hypot(x - source.cx, y - source.cy), i = (y * source.width + x) * 4;
      if (d < source.radius - 4) { expect(after.subarray(i, i + 4).equals(source.pixels.subarray(i, i + 4))).toBe(true); innerPixels++; }
      if (Math.abs(d - source.radius) > 1.5) continue;
      for (let c = 0; c < 3; c++) {
        const ideal = source.truth[i + c] * source.truth[i + 3] / 255;
        oldError += Math.abs(source.pixels[i + c] * source.pixels[i + 3] / 255 - ideal);
        newError += Math.abs(after[i + c] * after[i + 3] / 255 - ideal);
      }
    }
    expect(innerPixels).toBeGreaterThan(16000);
    expect(newError).toBeLessThan(oldError * 0.3);
    expect(Math.abs(result.report.radius! - source.radius)).toBeLessThan(0.3);
  });
  it.each([{ hole: true }, { ellipse: true }, { broken: true }, { whiteRim: true }])('does not force incompatible artwork into a solid dark-rimmed circle: %j', async options => {
    const source = await badge(options);
    const result = await refineCircularArtworkEdge(source.bytes);
    expect(result.report.applied).toBe(false);
    expect(result.bytes.equals(source.bytes)).toBe(true);
  });
});
