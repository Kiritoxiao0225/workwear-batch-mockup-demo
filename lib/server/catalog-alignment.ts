import sharp from 'sharp';
import { type Box, type CatalogAlignment } from '@/lib/catalog';

export const ALIGNMENT_VERSION = 'alpha-bounds-v1';
export const IDENTITY_ALIGNMENT: CatalogAlignment = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
type Silhouette = { bounds: Box; mask: Uint8Array; aspect: number };
export async function garmentSilhouette(bytes: Buffer, crop: Box): Promise<Silhouette | null> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.hasAlpha) return null;
  const width = metadata.width!; const height = metadata.height!;
  const left = Math.round(crop.x * width); const top = Math.round(crop.y * height);
  const faceWidth = Math.round(crop.width * width); const faceHeight = Math.round(crop.height * height);
  const { data: pixels, info } = await sharp(bytes).extract({ left, top, width: faceWidth, height: faceHeight }).resize(320, 384, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = 320, y0 = 384, x1 = -1, y1 = -1, count = 0;
  const alpha = new Uint8Array(320 * 384);
  for (let y = 0; y < 384; y++) for (let x = 0; x < 320; x++) {
    if (pixels[(y * 320 + x) * info.channels + info.channels - 1] < 128) continue;
    alpha[y * 320 + x] = 1; count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  // A fully opaque canvas is background, not evidence of matching garments.
  if (count < 320 * 384 * .02 || count > 320 * 384 * .97) return null;
  const mask = new Uint8Array(160 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 160; x++) {
    const sx = Math.min(x1, x0 + Math.floor((x + .5) * (x1 - x0 + 1) / 160));
    const sy = Math.min(y1, y0 + Math.floor((y + .5) * (y1 - y0 + 1) / 192));
    mask[y * 160 + x] = alpha[sy * 320 + sx];
  }
  const bounds = { x: x0 / 320, y: y0 / 384, width: (x1 - x0 + 1) / 320, height: (y1 - y0 + 1) / 384 };
  return { bounds, mask, aspect: bounds.width * faceWidth / (bounds.height * faceHeight) };
}
export function compareSilhouettes(source: Silhouette | null, target: Silhouette | null) {
  if (!source || !target) return { alignment: IDENTITY_ALIGNMENT, score: null, status: 'review' as const, reason: '图片没有可用透明轮廓；保留原位置，请对照预览人工核对' };
  const a = source.bounds; const b = target.bounds;
  const alignment = { scaleX: b.width / a.width, scaleY: b.height / a.height, offsetX: b.x - a.x * b.width / a.width, offsetY: b.y - a.y * b.height / a.height };
  let intersection = 0, union = 0;
  for (let i = 0; i < source.mask.length; i++) { intersection += source.mask[i] & target.mask[i]; union += source.mask[i] | target.mask[i]; }
  const score = intersection / union;
  const aspectChange = Math.abs(Math.log(target.aspect / source.aspect));
  const aligned = score >= .97 && aspectChange <= Math.log(1.03);
  return { alignment, score, status: aligned ? 'aligned' as const : 'review' as const, reason: aligned ? '轮廓已对齐；请核对领口、门襟、口袋和印制区域' : '轮廓或比例有差异；请逐项核对预览，必要时单独校准' };
}
