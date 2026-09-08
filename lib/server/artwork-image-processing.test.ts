import { readFile } from 'node:fs/promises';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  alphaMaskReport,
  applyArtworkAlphaMask,
  assertUsableArtworkMask,
  createArtworkRecolorMask,
  inspectArtworkSource,
  mediaKitStandardInputSize,
  missingArtworkForegroundRegions,
  removeFlatArtworkBackground,
} from '@/lib/server/artwork-image-processing';

describe('artwork source routing', () => {
  it('keeps portrait orientation while fitting MediaKit short/long edge limits', () => {
    expect(mediaKitStandardInputSize(1280, 2272)).toEqual({
      width: 1217,
      height: 2160,
    });
    expect(mediaKitStandardInputSize(2272, 1280)).toEqual({
      width: 2160,
      height: 1217,
    });
  });

  it('classifies the real green customer material as a flat background graphic', async () => {
    const source = await readFile('public/task-review-originals/row1-1.png');
    const profile = await inspectArtworkSource(source);

    expect(profile.kind).toBe('flat-background');
    expect(profile.dominantBorderRatio).toBeGreaterThan(0.75);
    expect(profile.backgroundColor).not.toBeNull();
  });

  it('separates a real flat logo canvas from a real complex customer photo', async () => {
    const flatLogo = await inspectArtworkSource(
      await readFile('public/task-review-originals/row2-1.png'),
    );
    const customerPhoto = await inspectArtworkSource(
      await readFile('public/task-review-originals/row2-3.png'),
    );

    expect(flatLogo.kind).toBe('flat-background');
    expect(customerPhoto.kind).toBe('complex-background');
  });

  it('treats the real small grey gradient wordmark as a simple smooth background', async () => {
    const wordmark = await inspectArtworkSource(
      await readFile('public/task-review-originals/row2-5.png'),
    );

    expect(wordmark.kind).toBe('flat-background');
    expect(wordmark.width).toBe(147);
    expect(wordmark.height).toBe(64);
    expect(wordmark.borderEdgeDensity).toBeLessThanOrEqual(0.02);
  });

  it('classifies a textured edge-to-edge image as a complex background', async () => {
    const width = 96;
    const height = 96;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = (x * 17 + y * 7) % 256;
        pixels[offset + 1] = (x * 3 + y * 19) % 256;
        pixels[offset + 2] = (x * 13 + y * 11) % 256;
      }
    }
    const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();

    expect((await inspectArtworkSource(source)).kind).toBe('complex-background');
  });

  it('does not mistake a solid canvas with a one-pixel transparent frame for a ready transparent graphic', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 45;
        pixels[offset + 1] = 180;
        pixels[offset + 2] = 86;
        pixels[offset + 3] = x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 0 : 255;
      }
    }
    const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const profile = await inspectArtworkSource(source);

    expect(profile.transparentRatio).toBeGreaterThan(0.02);
    expect(profile.transparentBorderRatio).toBeLessThan(0.65);
    expect(profile.kind).toBe('flat-background');
  });
});

describe('flat artwork preprocessing', () => {
  it('reuses the original alpha after enhancement and removes the white edge contamination', async () => {
    const width = 8;
    const height = 8;
    const maskPixels = Buffer.alloc(width * height * 4);
    const enhancedPixels = Buffer.alloc(width * height * 3, 255);
    const foreground = { r: 54, g: 43, b: 125 };
    maskPixels[(7 * width) * 4] = foreground.r;
    maskPixels[(7 * width) * 4 + 1] = foreground.g;
    maskPixels[(7 * width) * 4 + 2] = foreground.b;
    maskPixels[(7 * width) * 4 + 3] = 255;
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const alpha = x === 2 || x === 5 || y === 2 || y === 5 ? 128 : 255;
        const maskOffset = (y * width + x) * 4;
        maskPixels[maskOffset] = foreground.r;
        maskPixels[maskOffset + 1] = foreground.g;
        maskPixels[maskOffset + 2] = foreground.b;
        maskPixels[maskOffset + 3] = alpha;
        const enhancedOffset = (y * width + x) * 3;
        const opacity = alpha / 255;
        enhancedPixels[enhancedOffset] = Math.round(foreground.r * opacity + 255 * (1 - opacity));
        enhancedPixels[enhancedOffset + 1] = Math.round(foreground.g * opacity + 255 * (1 - opacity));
        enhancedPixels[enhancedOffset + 2] = Math.round(foreground.b * opacity + 255 * (1 - opacity));
      }
    }
    const mask = await sharp(maskPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const enhanced = await sharp(enhancedPixels, { raw: { width, height, channels: 3 } }).png().toBuffer();

    const result = await applyArtworkAlphaMask(enhanced, mask, { r: 255, g: 255, b: 255 });
    const { data } = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgbaAt = (x: number, y: number) => {
      const offset = (y * width + x) * 4;
      return [...data.subarray(offset, offset + 4)];
    };

    expect(rgbaAt(0, 0)).toEqual([0, 0, 0, 0]);
    expect(rgbaAt(0, 7)).toEqual([0, 0, 0, 0]);
    expect(rgbaAt(3, 3)).toEqual([foreground.r, foreground.g, foreground.b, 255]);
    expect(rgbaAt(2, 3)[3]).toBe(128);
    expect(rgbaAt(2, 3)[0]).toBeCloseTo(foreground.r, -1);
    expect(rgbaAt(2, 3)[1]).toBeCloseTo(foreground.g, -1);
    expect(rgbaAt(2, 3)[2]).toBeCloseTo(foreground.b, -1);
  });

  it('rejects enhanced output whose aspect ratio no longer matches the original logo', async () => {
    const mask = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    const distorted = await sharp({
      create: { width: 120, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();

    await expect(applyArtworkAlphaMask(distorted, mask)).rejects.toThrow('超过 1% 结构门禁');
  });

  it('removes the green canvas while keeping a solid foreground core', async () => {
    const source = await readFile('public/task-review-originals/row1-1.png');
    const profile = await inspectArtworkSource(source);
    if (!profile.backgroundColor) throw new Error('测试素材没有识别出背景色');

    const transparent = await removeFlatArtworkBackground(source, profile.backgroundColor);
    const report = await alphaMaskReport(transparent);

    expect(report.transparentRatio).toBeGreaterThan(0.7);
    expect(report.coreOpaqueAmongVisible).toBeGreaterThan(0.7);
    expect(() => assertUsableArtworkMask(report)).not.toThrow();
  });

  it('builds a recolor mask for the hand body without covering every foreground detail', async () => {
    const source = await readFile('public/task-review-originals/row1-1.png');
    const profile = await inspectArtworkSource(source);
    if (!profile.backgroundColor) throw new Error('测试素材没有识别出背景色');
    const transparent = await removeFlatArtworkBackground(source, profile.backgroundColor);
    const mask = await createArtworkRecolorMask(
      transparent,
      '只去绿色背景，保留音符和手势内部细节；将手势主体整体改为绿色',
    );
    if (!mask) throw new Error('真实手势素材没有生成可换色主体蒙版');

    const foreground = await alphaMaskReport(transparent);
    const recolor = await alphaMaskReport(mask);
    expect(recolor.visibleRatio / foreground.visibleRatio).toBeGreaterThan(0.3);
    expect(recolor.visibleRatio).toBeLessThan(foreground.visibleRatio);
    expect(recolor.coreOpaqueAmongVisible).toBeGreaterThan(0.8);
    const rawMask = await sharp(mask).ensureAlpha().raw().toBuffer();
    const alphaAt = (x: number, y: number) => rawMask[(y * 1280 + x) * 4 + 3];
    expect(alphaAt(500, 850)).toBeGreaterThan(240);
    expect(alphaAt(760, 850)).toBeGreaterThan(240);
    expect(alphaAt(600, 1450)).toBeGreaterThan(240);
    expect(alphaAt(340, 730)).toBe(0);
  });

  it('keeps all substantial subject parts while excluding white details and a small detached note', async () => {
    const width = 80;
    const height = 64;
    const pixels = Buffer.alloc(width * height * 4);
    const paint = (left: number, top: number, right: number, bottom: number, color: [number, number, number, number]) => {
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * width + x) * 4;
          pixels[offset] = color[0];
          pixels[offset + 1] = color[1];
          pixels[offset + 2] = color[2];
          pixels[offset + 3] = color[3];
        }
      }
    };
    paint(20, 20, 60, 58, [18, 18, 18, 255]);
    paint(8, 24, 16, 52, [18, 18, 18, 255]);
    paint(31, 32, 42, 43, [255, 255, 255, 255]);
    paint(63, 24, 66, 53, [35, 190, 90, 255]);
    paint(45, 20, 47, 58, [0, 0, 0, 0]);
    paint(4, 5, 7, 10, [18, 18, 18, 255]);
    const graphic = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const mask = await createArtworkRecolorMask(graphic, '将手势主体整体改为绿色，保留内部白色细节和音符');
    if (!mask) throw new Error('合成手势素材没有生成换色蒙版');
    const rawMask = await sharp(mask).ensureAlpha().raw().toBuffer();
    const alphaAt = (x: number, y: number) => rawMask[(y * width + x) * 4 + 3];

    expect(alphaAt(30, 30)).toBe(255);
    expect(alphaAt(10, 30)).toBe(255);
    expect(alphaAt(35, 36)).toBe(0);
    expect(alphaAt(64, 30)).toBe(255);
    expect(alphaAt(45, 30)).toBe(255);
    expect(alphaAt(5, 7)).toBe(0);
  });
});

describe('MediaKit mask quality gate', () => {
  it('rejects a mostly soft alpha mask even when it contains plenty of transparent pixels', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 20; y < 80; y += 1) {
      for (let x = 20; x < 80; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 20;
        pixels[offset + 1] = 120;
        pixels[offset + 2] = 60;
        pixels[offset + 3] = 90;
      }
    }
    const fuzzy = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const report = await alphaMaskReport(fuzzy);

    expect(report.transparentRatio).toBeGreaterThan(0.5);
    expect(() => assertUsableArtworkMask(report)).toThrow('完全不透明主体不足');
  });

  it('rejects an almost opaque canvas with only a thin transparent strip', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels[(y * width + x) * 4 + 3] = 0;
      }
    }
    const failedCutout = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const report = await alphaMaskReport(failedCutout);

    expect(report.transparentRatio).toBeCloseTo(0.02);
    expect(() => assertUsableArtworkMask(report)).toThrow('透明背景不足 5%');
  });
});

describe('independent foreground preservation', () => {
  const white = { r: 255, g: 255, b: 255 };

  async function registeredMarkFixture(missing: 'none' | 'registered' | 'inner-mark' | 'soft-body') {
    const width = 64;
    const height = 48;
    const source = Buffer.alloc(width * height * 4, 255);
    const rectangle = (left: number, top: number, rectWidth: number, rectHeight: number, value: number) => {
      for (let y = top; y < top + rectHeight; y += 1) {
        for (let x = left; x < left + rectWidth; x += 1) {
          const offset = (y * width + x) * 4;
          source[offset] = value;
          source[offset + 1] = value;
          source[offset + 2] = value;
        }
      }
    };
    rectangle(4, 16, 24, 24, 35);
    rectangle(9, 21, 14, 14, 255); // A white letter counter is background, not lost ink.
    rectangle(44, 4, 12, 12, 35);
    rectangle(46, 6, 8, 8, 255);
    rectangle(48, 8, 2, 4, 35); // Independent inner mark, enclosed by the ring's bounds.
    rectangle(60, 42, 3, 3, 230); // Pale compression artifact must not become a component.
    rectangle(61, 1, 1, 1, 35); // One dark speck is too small to recover.

    const cutout = Buffer.from(source);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const removed = source[offset] > 200 || (x === 61 && y === 1)
          || (missing === 'registered' && x >= 44 && x < 56 && y >= 4 && y < 16)
          || (missing === 'inner-mark' && x >= 48 && x < 50 && y >= 8 && y < 12);
        cutout[offset + 3] = removed ? 0
          : missing === 'soft-body' && x >= 4 && x < 28 && y >= 16 && y < 40 ? 159 : 255;
      }
    }
    return {
      source: await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer(),
      cutout: await sharp(cutout, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    };
  }

  it('finds a removed registered mark while the main lettering remains intact', async () => {
    const fixture = await registeredMarkFixture('registered');

    expect(await missingArtworkForegroundRegions(fixture.source, fixture.cutout, white)).toEqual([
      { left: 44, top: 4, width: 12, height: 12 },
    ]);
  });

  it('includes the retained enclosing ring when only its inner mark disappeared', async () => {
    const fixture = await registeredMarkFixture('inner-mark');

    expect(await missingArtworkForegroundRegions(fixture.source, fixture.cutout, white)).toEqual([
      { left: 44, top: 4, width: 12, height: 12 },
    ]);
  });

  it('does not mistake transparent white counters or removed JPEG specks for missing artwork', async () => {
    const fixture = await registeredMarkFixture('none');

    expect(await missingArtworkForegroundRegions(fixture.source, fixture.cutout, white)).toEqual([]);
  });

  it('rejects mostly translucent lettering as insufficiently retained', async () => {
    const fixture = await registeredMarkFixture('soft-body');

    expect(await missingArtworkForegroundRegions(fixture.source, fixture.cutout, white)).toEqual([
      { left: 4, top: 16, width: 24, height: 24 },
    ]);
  });

  it('refuses to compare different canvases', async () => {
    const fixture = await registeredMarkFixture('none');
    const resized = await sharp(fixture.cutout).resize({ width: 32 }).png().toBuffer();

    await expect(missingArtworkForegroundRegions(fixture.source, resized, white))
      .rejects.toThrow('抠图前后画布尺寸不一致');
  });

  it('keeps a six-pixel diagonal punctuation stroke as one eight-connected component', async () => {
    const pixels = Buffer.alloc(8 * 8 * 4, 255);
    for (let coordinate = 1; coordinate <= 6; coordinate += 1) {
      const offset = (coordinate * 8 + coordinate) * 4;
      pixels.fill(30, offset, offset + 3);
    }
    const source = await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
    const cutout = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { ...white, alpha: 0 } },
    }).png().toBuffer();

    expect(await missingArtworkForegroundRegions(source, cutout, white)).toEqual([
      { left: 1, top: 1, width: 6, height: 6 },
    ]);
  });

  it('accepts exactly 80 percent of a component at alpha 160 and flags lower retention', async () => {
    const sourcePixels = Buffer.alloc(7 * 4 * 4, 255);
    const cutoutPixels = Buffer.alloc(7 * 4 * 4);
    const offsets: number[] = [];
    for (let y = 1; y <= 2; y += 1) {
      for (let x = 1; x <= 5; x += 1) {
        const offset = (y * 7 + x) * 4;
        sourcePixels.fill(30, offset, offset + 3);
        offsets.push(offset);
        if (offsets.length <= 8) cutoutPixels[offset + 3] = 160;
      }
    }
    const source = await sharp(sourcePixels, { raw: { width: 7, height: 4, channels: 4 } }).png().toBuffer();
    const atThreshold = await sharp(cutoutPixels, { raw: { width: 7, height: 4, channels: 4 } }).png().toBuffer();
    expect(await missingArtworkForegroundRegions(source, atThreshold, white)).toEqual([]);

    cutoutPixels[offsets[0] + 3] = 159;
    const belowThreshold = await sharp(cutoutPixels, { raw: { width: 7, height: 4, channels: 4 } }).png().toBuffer();
    expect(await missingArtworkForegroundRegions(source, belowThreshold, white)).toEqual([
      { left: 1, top: 1, width: 5, height: 2 },
    ]);
  });
});
