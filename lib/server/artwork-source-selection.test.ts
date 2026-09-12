import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { selectArtworkSource } from './artwork-source-selection';
import { removeFlatArtworkBackground } from './artwork-image-processing';
import { validateCutoutOutput } from './artwork-cutout-analysis';

const screenshot = () => sharp(Buffer.from('<svg width="500" height="400"><rect width="500" height="400" fill="white"/><rect width="500" height="40" fill="gray"/><rect x="30" y="100" width="140" height="100" fill="red"/><rect x="60" y="120" width="40" height="60" fill="white"/><rect x="330" y="100" width="100" height="180" fill="blue"/><rect x="360" y="150" width="30" height="60" fill="yellow"/><rect x="40" y="320" width="100" height="30" fill="purple"/></svg>')).png().toBuffer();

describe('target selection before background removal', () => {
  it('isolates separate versions and preserves every original pixel including white lettering', async () => {
    const source = await screenshot();
    for (const bounds of [{ left: 40, top: 225, right: 360, bottom: 525 }, { left: 640, top: 225, right: 880, bottom: 725 }]) {
      const selected = await selectArtworkSource(source, { scope: 'region', bounds });
      const expected = await sharp(source).extract(selected.receipt!.bounds).ensureAlpha().raw().toBuffer();
      expect(await sharp(selected.bytes).ensureAlpha().raw().toBuffer()).toEqual(expected);
      const cutout = await removeFlatArtworkBackground(selected.bytes, { r: 255, g: 255, b: 255 });
      await expect(validateCutoutOutput(cutout, selected.bytes)).resolves.toMatchObject({ watermarks: [], integrity: { status: 'checked' } });
      const { data } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(Array.from(data).filter((value, index) => index % 4 === 3 && value === 255).length).toBeGreaterThan(5000);
      if (bounds.left === 40) {
        const width = selected.receipt!.bounds.width;
        expect([...data.subarray((40 * width + 50) * 4, (40 * width + 50) * 4 + 4)]).toEqual([255, 255, 255, 255]);
      }
    }
  });
  it('keeps whole artwork bytes unchanged', async () => {
    const bytes = await screenshot();
    expect((await selectArtworkSource(bytes, { scope: 'full-image' })).bytes).toBe(bytes);
  });
  it.each([undefined, { scope: 'unknown' }, { scope: 'region', bounds: { left: 800, top: 0, right: 200, bottom: 1000 } },
    { scope: 'region', bounds: { left: 0, top: 0, right: 1001, bottom: 1000 } }] as const)('blocks missing, uncertain or invalid bounds', async selection => {
    await expect(selectArtworkSource(await screenshot(), selection)).rejects.toThrow('尚未确定本次要用的图案范围');
  });
});
