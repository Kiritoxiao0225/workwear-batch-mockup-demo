import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectArtworkBadges, protectArtworkBadges } from './artwork-badge-protection';

const svg = (content: string, transparent = false) => sharp(Buffer.from(`<svg width="400" height="400">${transparent ? '' : '<rect width="400" height="400" fill="white"/>'}${content}</svg>`)).png().toBuffer();
const ring = '<circle cx="200" cy="210" r="120" fill="none" stroke="#e11" stroke-width="6"/>';
const symbol = '<path d="M170 180h60v60h-60z M190 200h20v20h-20z" fill="#e11" fill-rule="evenodd"/>';

describe('original badge backing protection shared by both cutout providers', () => {
  it('restores the annular backing and internal white symbol from the source while leaving outside lettering holes transparent', async () => {
    const outside = '<path d="M12 12h60v60H12z M25 25v30h30V25z" fill="#db0" fill-rule="evenodd"/>';
    const source = await svg(ring + symbol + outside);
    const cutout = await svg(ring + symbol + outside, true);
    const protectedResult = await protectArtworkBadges(source, cutout);
    expect(protectedResult.regions).toHaveLength(1);
    const original = await sharp(source).ensureAlpha().raw().toBuffer();
    const result = await sharp(protectedResult.bytes).ensureAlpha().raw().toBuffer();
    const raw = await sharp(cutout).ensureAlpha().raw().toBuffer();
    let outsidePixels = 0;
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (Math.hypot(x - 200, y - 210) < 110) expect(result.subarray(i, i + 4).equals(original.subarray(i, i + 4))).toBe(true);
      if (Math.hypot(x - 200, y - 210) > 125) { expect(result.subarray(i, i + 4).equals(raw.subarray(i, i + 4))).toBe(true); outsidePixels++; }
    }
    expect(outsidePixels).toBeGreaterThan(100000);
    expect(result[(35 * 400 + 35) * 4 + 3]).toBe(0);
  });
  it.each([
    ['empty O/0 ring', ring, false],
    ['already transparent design', ring + symbol, true],
    ['broken frame', ring + symbol + '<rect x="310" y="200" width="25" height="20" fill="white"/>', false],
    ['square badge', '<rect x="80" y="90" width="240" height="240" fill="none" stroke="#e11" stroke-width="6"/>' + symbol, false],
    ['ellipse', '<ellipse cx="200" cy="210" rx="120" ry="90" fill="none" stroke="#e11" stroke-width="6"/>' + symbol, false],
  ] as const)('does not invent white for %s', async (_name, content, transparent) => {
    expect(await detectArtworkBadges(await svg(content, transparent))).toEqual([]);
  });
  it('blocks a provider crop instead of restoring original pixels at the wrong position', async () => {
    const source = await svg(ring + symbol);
    const cropped = await sharp(await svg(ring + symbol, true)).extract({ left: 60, top: 70, width: 280, height: 280 }).png().toBuffer();
    await expect(protectArtworkBadges(source, cropped)).rejects.toThrow('画布一致');
  });
});
