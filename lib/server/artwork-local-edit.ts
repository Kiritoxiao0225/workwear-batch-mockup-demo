import sharp from 'sharp';
import type { ArtworkPixelBounds } from './artwork-image-processing';
import { artworkForegroundEvidence, pixelComponents } from './artwork-foreground-integrity';

export type ArtworkLocalEditPlan = {
  status: 'absent' | 'located' | 'uncertain';
  regions: ArtworkPixelBounds[];
  evidence: string;
};

/** Coordinates must refer to these actual pixels, never to a pre-crop source. */
export function validateLocalEditPlan(plan: ArtworkLocalEditPlan, width: number, height: number): ArtworkLocalEditPlan {
  if (!['absent', 'located', 'uncertain'].includes(plan.status) || !Array.isArray(plan.regions)) throw new Error('局部修改定位回执无效');
  if (plan.status !== 'located') return { ...plan, regions: [] };
  if (!plan.regions.length || plan.regions.length > 4) throw new Error('局部修改需要 1–4 个明确区域');
  let area = 0;
  for (const r of plan.regions) {
    if (![r.left, r.top, r.width, r.height].every(Number.isSafeInteger) || r.left < 0 || r.top < 0 || r.width < 1 || r.height < 1 || r.left + r.width > width || r.top + r.height > height) throw new Error('局部修改选区越界');
    area += r.width * r.height;
  }
  // An uncertain whole-logo edit is not disguised as a local deletion.
  if (area > width * height * .4) throw new Error('待删除区域过大，无法保证未编辑图形保真，请提供明确选区');
  return plan;
}

/** Delete only completely isolated components on an existing Alpha canvas.
 * No OCR or colour guess is used to erase pixels. The locator supplies the
 * semantic target; component identity ensures the main logo cannot be erased. */
export async function eraseDetachedArtwork(source: Buffer, plan: ArtworkLocalEditPlan): Promise<Buffer | null> {
  const evidence = await artworkForegroundEvidence(source);
  validateLocalEditPlan(plan, evidence.width, evidence.height);
  if (plan.status !== 'located' || evidence.kind !== 'alpha') return null;
  const { regions, labels } = pixelComponents(evidence.mask, evidence.width, evidence.height);
  const inside = (x: number, y: number) => plan.regions.some(r => x >= r.left && y >= r.top && x < r.left + r.width && y < r.top + r.height);
  const selected = new Set<number>();
  const largest = Math.max(0, ...regions.map(r => r.count));
  for (const r of regions) {
    const intersects = plan.regions.some(p => p.left < r.left + r.width && r.left < p.left + p.width && p.top < r.top + r.height && r.top < p.top + p.height);
    if (!intersects) continue;
    if (!plan.regions.some(p => p.left <= r.left && p.top <= r.top && p.left + p.width >= r.left + r.width && p.top + p.height >= r.top + r.height)
      || r.count === largest) return null;
    selected.add(r.label);
  }
  if (!selected.size) return null;
  // Soft anti-alias fringes crossing the boundary are not safely separated.
  for (let y = 0; y < evidence.height; y++) for (let x = 0; x < evidence.width; x++) {
    const p = y * evidence.width + x;
    if (evidence.data[p * 4 + 3] === 0 || !inside(x, y)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < evidence.width && ny >= 0 && ny < evidence.height && !inside(nx, ny) && evidence.data[(ny * evidence.width + nx) * 4 + 3] > 0) return null;
    }
    if (labels[p] && !selected.has(labels[p])) return null;
  }
  const data = Buffer.from(evidence.data);
  for (let y = 0; y < evidence.height; y++) for (let x = 0; x < evidence.width; x++) if (inside(x, y)) data[(y * evidence.width + x) * 4 + 3] = 0;
  return sharp(data, { raw: { width: evidence.width, height: evidence.height, channels: 4 } }).png().toBuffer();
}

/** Model pixels are allowed ONLY inside explicit ROIs. Outside: byte-for-byte
 * original RGBA, including holes, colour, registered marks and white outline. */
export async function compositeArtworkLocalEdit(source: Buffer, generated: Buffer, plan: ArtworkLocalEditPlan) {
  const original = await sharp(source).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height } = original.info;
  validateLocalEditPlan(plan, width, height);
  if (plan.status !== 'located') throw new Error('未定位的修改不能合成');
  const meta = await sharp(generated).metadata();
  if (!meta.width || !meta.height || Math.abs((meta.width / meta.height) / (width / height) - 1) > .01) throw new Error('局部修改模型改变了画布比例，候选已保留');
  const edited = await sharp(generated).resize(width, height, { fit: 'fill' }).ensureAlpha().toColourspace('srgb').raw().toBuffer();
  const output = Buffer.from(original.data);
  for (const r of plan.regions) for (let y = r.top; y < r.top + r.height; y++) {
    const start = (y * width + r.left) * 4, end = start + r.width * 4;
    edited.copy(output, start, start, end);
  }
  return sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
