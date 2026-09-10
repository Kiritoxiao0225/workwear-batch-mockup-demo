import sharp from 'sharp';
import type { ArtworkSolidColor } from '@/lib/artwork-solid-color';
import { artworkSha256 } from './artwork-quality';

/** Preserve every alpha sample and hole; named colors use the image's actual ink, not a preset. */
export async function flattenArtworkSolidColor(bytes: Buffer, contract: ArtworkSolidColor) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let samples = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) continue;
    samples++;
    for (let c = 0; c < 3; c++) channels[c][data[i + c]]++;
  }
  if (!samples) throw new Error('图案没有可可靠取色的实心区域，无法统一颜色');
  const rgb = /^#[0-9a-f]{6}$/iu.test(contract.color)
    ? [1, 3, 5].map(start => parseInt(contract.color.slice(start, start + 2), 16))
    : channels.map(histogram => {
      let count = 0;
      for (let value = 0; value < 256; value++) { count += histogram[value]; if (count >= samples / 2) return value; }
      return 0;
    });
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    for (let c = 0; c < 3; c++) data[i + c] = rgb[c];
  }
  const output = await sharp(data, { raw: info }).png().toBuffer();
  const hex = `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
  return { bytes: output, receipt: { version: 'artwork-solid-color-v1', requirement: contract.requirement, color: hex,
    colorSource: contract.color.startsWith('#') ? 'specified' : 'foreground-median',
    inputSha256: artworkSha256(bytes), outputSha256: artworkSha256(output), alphaPreserved: true } };
}
