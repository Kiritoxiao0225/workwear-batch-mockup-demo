import { expect, it } from 'vitest';
import sharp from 'sharp';
import { boundedModelImage, fidelityModelImage, MAX_MODEL_IMAGE_BYTES } from './model-image-input';
it('keeps normal analysis inputs byte-for-byte instead of degrading small text', async () => {
  const original = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#345678' } }).jpeg().toBuffer();
  expect((await boundedModelImage(original)).bytes).toEqual(original);
});
it('reduces oversized inputs without losing resolution when compression suffices', async () => {
  const original = await sharp({ create: { width: 2200, height: 1800, channels: 3, background: '#18432a' } }).png({ compressionLevel: 0 }).toBuffer();
  expect(original.length).toBeGreaterThan(MAX_MODEL_IMAGE_BYTES);
  const input = await boundedModelImage(original);
  expect(input.bytes.length).toBeLessThan(MAX_MODEL_IMAGE_BYTES);
  const before = await sharp(original).raw().toBuffer(), after = await sharp(input.bytes).raw().toBuffer();
  expect(after.equals(before)).toBe(true);
  const production = await fidelityModelImage(original);
  expect((await sharp(production.bytes).raw().toBuffer()).equals(before)).toBe(true);
});
