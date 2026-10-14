/**
 * 电商主图 画板 edits: the mask the generator redraws through, and the paste-back that keeps the
 * rest of the image pixel for pixel. Boxes are in percent of the image.
 */
import sharp from 'sharp';
import type { Box } from '../listing/templates';

const px = (b: Box, w: number, h: number) => {
  const left = Math.max(0, Math.floor(b[0] / 100 * w)), top = Math.max(0, Math.floor(b[1] / 100 * h));
  return { left, top, width: Math.max(1, Math.min(w - left, Math.ceil(b[2] / 100 * w))), height: Math.max(1, Math.min(h - top, Math.ceil(b[3] / 100 * h))) };
};
/** Grow a box a little so the redrawn part blends in at its edge. */
export const pad = (b: Box, by = 1.5): Box => [Math.max(0, b[0] - by), Math.max(0, b[1] - by), Math.min(100 - Math.max(0, b[0] - by), b[2] + 2 * by), Math.min(100 - Math.max(0, b[1] - by), b[3] + 2 * by)];

/** Alpha of the boxes: 255 inside, 0 outside, softened over `feather` pixels at the edge. */
async function alphaOf(boxes: Box[], width: number, height: number, feather: number) {
  const parts = boxes.map(b => px(b, width, height)).map(r => ({ input: { create: { width: r.width, height: r.height, channels: 3 as const, background: '#ffffff' } }, left: r.left, top: r.top }));
  // sharp runs a pipeline's steps in its own order, not as written: each step gets its own pass.
  let img = sharp(await sharp({ create: { width, height, channels: 3, background: '#000000' } }).composite(parts).png().toBuffer());
  if (feather > 0) img = sharp(await img.blur(feather).png().toBuffer());
  return img.extractChannel(0).raw().toBuffer();
}

/** The generator's mask: a PNG the size of the image, transparent inside the boxes (redraw), opaque outside (keep). */
export async function maskOf(boxes: Box[], width: number, height: number) {
  const inside = await alphaOf(boxes, width, height, 0);
  const alpha = Buffer.from(inside.map(v => 255 - v));
  return sharp(Buffer.alloc(width * height * 3, 0), { raw: { width, height, channels: 3 } }).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/**
 * The redrawn image only where it was asked for: the generator repaints the whole picture slightly,
 * so its result is laid over the original through the boxes, softened at the edge.
 */
export async function pasteBack(original: Buffer, redrawn: Buffer, boxes: Box[]) {
  const meta = await sharp(original).metadata(), width = meta.width!, height = meta.height!;
  const alpha = await alphaOf(boxes, width, height, Math.max(2, Math.round(Math.min(width, height) / 300)));
  const rgb = await sharp(redrawn).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const top = await sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
  // Stored like the other main images.
  return sharp(original).removeAlpha().composite([{ input: top }]).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}
