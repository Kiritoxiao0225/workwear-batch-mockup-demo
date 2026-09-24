import sharp from 'sharp';
import type { Box } from '@/lib/catalog';

export const STRUCTURE_ESTIMATE_ALGORITHM = 'alpha-structure-v1';
/** torsoAtArmpit: torso width just below separated sleeves, the reliable width when long sleeves touch the body lower down. */
export type SilhouetteMeasure = { top: number; bottom: number; armpit: number; center: number; bodyWidth: number; armpitDetected: boolean; torsoAtArmpit: number | null };

/**
 * Measures one face from its alpha silhouette, in fractions of the face crop.
 * The top skips thin hanger hooks; the armpit is where the sleeves separate from the
 * torso, or where short sleeves end. Long sleeves hanging against the body cannot be
 * separated, so an implausible result falls back to the catalog-wide ratio and says so.
 */
export async function measureSilhouette(bytes: Buffer, crop: Box): Promise<SilhouetteMeasure | null> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.hasAlpha) return null;
  const left = Math.round(crop.x * metadata.width!), top = Math.round(crop.y * metadata.height!);
  const faceWidth = Math.round(crop.width * metadata.width!), faceHeight = Math.round(crop.height * metadata.height!);
  const w = 320, h = Math.max(1, Math.round(w * faceHeight / faceWidth));
  const { data, info } = await sharp(bytes).extract({ left, top, width: faceWidth, height: faceHeight }).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows: [number, number][][] = [];
  for (let y = 0; y < h; y++) {
    const runs: [number, number][] = []; let start = -1;
    for (let x = 0; x < w; x++) {
      const opaque = data[(y * w + x) * info.channels + info.channels - 1] >= 128;
      if (opaque && start < 0) start = x;
      if ((!opaque || x === w - 1) && start >= 0) { if (x - start > 2) runs.push([start, x]); start = -1; }
    }
    rows.push(runs);
  }
  const span = (r: [number, number][]) => r.length ? r.at(-1)![1] - r[0][0] : 0;
  const maxSpan = Math.max(...rows.map(span));
  if (maxSpan < w * .15) return null;
  const first = rows.findIndex(r => span(r) >= maxSpan * .12), last = h - 1 - [...rows].reverse().findIndex(r => r.length);
  if (first < 0 || last - first < h * .2) return null;
  const middle = w / 2;
  const torsoRun = (y: number) => rows[y].find(([s, e]) => s < middle && e > middle);
  const separated = (y: number) => { const r = rows[y]; return r.length >= 3 && !!torsoRun(y) && r[0][1] < middle && r.at(-1)![0] > middle; };
  let split = -1;
  for (let y = first + Math.round((last - first) * .15); y < last - 8 && split < 0; y++) {
    let sustained = true; for (let k = 0; k < 8; k++) if (!separated(y + k)) { sustained = false; break; }
    if (sustained) split = y;
  }
  let widest = first; for (let y = first; y < first + (last - first) * .6; y++) if (span(rows[y]) > span(rows[widest])) widest = y;
  let drop = -1; for (let y = widest; y < last; y++) if (span(rows[y]) < span(rows[widest]) * .85) { drop = y; break; }
  let armpit = split >= 0 && (drop < 0 || split <= drop + 5) ? split : drop;
  const ratio = (armpit - first) / (last - first);
  const armpitDetected = armpit >= 0 && ratio >= .28 && ratio <= .58;
  if (!armpitDetected) armpit = Math.round(first + (last - first) * .43);
  // Lower torso (60–80% of the height) gives the center and a width even with long sleeves.
  const widths: number[] = [], centers: number[] = [];
  for (let y = Math.round(first + (last - first) * .6); y <= first + (last - first) * .8; y++) { const r = torsoRun(y); if (r) { widths.push(r[1] - r[0]); centers.push((r[0] + r[1]) / 2); } }
  widths.sort((a, b) => a - b); centers.sort((a, b) => a - b);
  const center = centers.length ? centers[centers.length >> 1] : middle;
  const bodyWidth = widths.length ? Math.min(widths[widths.length >> 1], maxSpan) : maxSpan * .6;
  let torsoAtArmpit: number | null = null;
  if (armpitDetected && armpit === split) {
    const near: number[] = []; for (let y = armpit + 2; y <= Math.min(last, armpit + 2 + Math.round(h * .03)); y++) { const r = torsoRun(y); if (r && separated(y)) near.push(r[1] - r[0]); }
    near.sort((a, b) => a - b); const median = near.length >= 4 ? near[near.length >> 1] / w : null;
    torsoAtArmpit = median && median >= .25 && median <= .8 ? median : null;
  }
  // Structure points sit on the torso edge under the arm when sleeves separate there; lower down long sleeves may touch the body.
  return { top: first / h, bottom: last / h, armpit: armpit / h, center: center / w, bodyWidth: torsoAtArmpit ?? bodyWidth / w, armpitDetected, torsoAtArmpit };
}
