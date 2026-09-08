import sharp from 'sharp';
import { visibleArtworkBounds } from './artwork-image-processing';

/** A changes to a cropped subject canvas; D keeps the full canvas. Align the
 * new mask to the existing layer so retrying background removal cannot move text. */
export async function alignCutoutLayer(result: Buffer, current: Buffer) {
  const size = await sharp(current).metadata();
  const oldBounds = await visibleArtworkBounds(current), newBounds = await visibleArtworkBounds(result);
  if (!size.width || !size.height) throw new Error('当前图层尺寸无效');
  const content = await sharp(result).extract(newBounds).resize({ width: oldBounds.width, height: oldBounds.height, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: size.width, height: size.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: content, left: oldBounds.left, top: oldBounds.top }]).png().toBuffer();
}
