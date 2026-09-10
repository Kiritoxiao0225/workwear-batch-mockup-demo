import { expect, it } from 'vitest';
import sharp from 'sharp';
import { flattenArtworkSolidColor } from './artwork-solid-color';
import { artworkSha256 } from './artwork-quality';

it('removes interior shading while preserving every alpha, detached stroke and hole', async () => {
  const data = Buffer.from([240, 180, 10, 255, 244, 184, 14, 255, 0, 0, 0, 0, 245, 185, 15, 255, 246, 186, 16, 255, 90, 70, 0, 70]);
  const bytes = await sharp(data, { raw: { width: 3, height: 2, channels: 4 } }).png().toBuffer();
  const result = await flattenArtworkSolidColor(bytes, { color: '黄色', requirement: '整组使用统一金黄色' });
  const output = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  const colors = new Set<string>();
  for (let i = 0; i < data.length; i += 4) {
    expect(output[i + 3]).toBe(data[i + 3]);
    if (data[i + 3]) colors.add(output.subarray(i, i + 3).toString('hex'));
  }
  expect([...colors]).toEqual(['f4b80e']);
  expect(result.receipt).toMatchObject({ alphaPreserved: true, inputSha256: artworkSha256(bytes), outputSha256: artworkSha256(result.bytes), colorSource: 'foreground-median' });
});
it('uses an explicit hex exactly rather than replacing it with the sampled ink', async () => {
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#efbb10' } }).png().toBuffer();
  const result = await flattenArtworkSolidColor(bytes, { color: '#eeb90e', requirement: '整组图案使用统一#eeb90e' });
  const output = await sharp(result.bytes).raw().toBuffer();
  expect([...output.subarray(0, 4)]).toEqual([238, 185, 14, 255]);
});
