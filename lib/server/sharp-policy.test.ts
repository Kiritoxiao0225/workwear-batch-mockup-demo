import sharp from 'sharp';
import { afterAll, expect, it } from 'vitest';
import { BLOCKED_SHARP_OPERATIONS } from './sharp-policy';

// The block is process-wide; other test files build fixtures from SVG.
afterAll(() => sharp.unblock({ operation: BLOCKED_SHARP_OPERATIONS }));

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');

it('refuses SVG input once the policy is loaded', async () => {
  await expect(sharp(svg).metadata()).rejects.toThrow(/unsupported image format/);
});

it('still decodes the upload formats', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#c33' } }).png().toBuffer();
  for (const [format, bytes] of [['png', png], ['jpeg', await sharp(png).jpeg().toBuffer()], ['webp', await sharp(png).webp().toBuffer()]] as const) {
    expect((await sharp(bytes).metadata()).format).toBe(format);
  }
});
