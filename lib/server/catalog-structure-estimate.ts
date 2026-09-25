import sharp from 'sharp';
import type { Box } from '@/lib/catalog';

export const STRUCTURE_ESTIMATE_ALGORITHM = 'alpha-structure-v2';
export type StructurePointKey = 'neckCenter' | 'leftShoulder' | 'rightShoulder' | 'leftArmpit' | 'rightArmpit' | 'hemCenter' | 'button2' | 'button3';
/** Structure points found on the image itself (crop fractions); a missing key was not found. */
export type StructurePoints = Partial<Record<StructurePointKey, { x: number; y: number }>>;
/**
 * torsoAtArmpit: torso width just below separated sleeves, the reliable width when long sleeves touch the body lower down.
 * points: shoulder, armpit and hem points read off the outline; long sleeves hanging against the body hide the armpits.
 */
export type SilhouetteMeasure = { top: number; bottom: number; armpit: number; center: number; bodyWidth: number; armpitDetected: boolean; torsoAtArmpit: number | null; points: StructurePoints };

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
  return { top: first / h, bottom: last / h, armpit: armpit / h, center: center / w, bodyWidth: torsoAtArmpit ?? bodyWidth / w, armpitDetected, torsoAtArmpit,
    points: outlinePoints(rows, first, last, center, maxSpan, w, h) };
}

/**
 * Armpit: walking up the torso side from the lower body, the first row where the edge leaves that
 * line outward is the sleeve's underside; the point sits on the torso line there. Shoulder: the top
 * outline turns from the gentle shoulder slope into the steeper sleeve; that turn is the point
 * farthest above the chord from the neck side to the sleeve's outermost column.
 */
function outlinePoints(rows: [number, number][][], first: number, last: number, center: number, maxSpan: number, w: number, h: number): StructurePoints {
  const points: StructurePoints = {};
  const torsoRun = (y: number) => rows[y].find(([s, e]) => s <= center && e >= center);
  const topY = Array.from({ length: w }, (_, x) => { for (let y = first; y <= last; y++) if (rows[y].some(([s, e]) => x >= s && x < e)) return y; return -1; });
  const lo = Math.round(first + (last - first) * .5), hi = Math.round(first + (last - first) * .75);
  const widths: number[] = []; for (let y = lo; y <= hi; y++) { const t = torsoRun(y); if (t) widths.push(t[1] - t[0]); }
  widths.sort((a, b) => a - b);
  // Sleeves merged with the body there leave no torso side to follow.
  const merged = !widths.length || widths[widths.length >> 1] > maxSpan * .8;
  for (const side of [-1, 1] as const) {
    const key = side < 0 ? 'left' : 'right';
    const edge = (y: number) => { const t = torsoRun(y); return t ? (side < 0 ? t[0] : t[1] - 1) : null; };
    let armpit: { x: number; y: number } | null = null;
    if (!merged) {
      const below: number[] = [];
      for (let y = hi; y > first && !armpit; y--) {
        const e = edge(y); if (e === null) break;
        if (below.length >= 6) {
          const line = [...below].sort((a, b) => a - b)[below.length >> 1];
          if ((e - line) * side > w * .03) {
            // A sloping sleeve underside leaves gradually; back down to where it starts.
            let start = y; while (start < hi && ((edge(start) ?? line) - line) * side > w * .006) start++;
            armpit = { x: line, y: start };
          }
        }
        below.unshift(e); if (below.length > 12) below.pop();
      }
    }
    if (armpit) points[`${key}Armpit`] = { x: armpit.x / w, y: armpit.y / h };
    const limit = armpit ? armpit.y : Math.round(first + (last - first) * .45);
    let outer = Math.round(center);
    for (let y = first; y <= limit; y++) for (const [s, e] of rows[y]) { if (side < 0 && s < outer) outer = s; if (side > 0 && e - 1 > outer) outer = e - 1; }
    const neck = Math.round(center + side * .12 * Math.abs(outer - center));
    if (topY[outer] < 0 || topY[neck] < 0 || outer === neck) continue;
    let best: [number, number] | null = null, depth = 0;
    for (let x = neck; side < 0 ? x >= outer : x <= outer; x += side) {
      if (topY[x] < 0) continue;
      const chord = topY[neck] + (x - neck) * (topY[outer] - topY[neck]) / (outer - neck);
      if (chord - topY[x] > depth) { depth = chord - topY[x]; best = [x, topY[x]]; }
    }
    // A straight shoulder-to-sleeve line (raglan) has no turn to find.
    if (best && depth > w * .008) points[`${key}Shoulder`] = { x: best[0] / w, y: best[1] / h };
  }
  // Catalog photos lay the garment flat and symmetric: a side the outline hid mirrors the other.
  for (const [a, b] of [['leftArmpit', 'rightArmpit'], ['leftShoulder', 'rightShoulder']] as const) {
    const pa = points[a], pb = points[b];
    if (pa && !pb) points[b] = { x: (2 * center - pa.x * w) / w, y: pa.y };
    if (pb && !pa) points[a] = { x: (2 * center - pb.x * w) / w, y: pb.y };
  }
  const hems: number[] = [];
  for (let x = Math.round(center) - 3; x <= Math.round(center) + 3; x++) for (let y = last; y >= first; y--) if (rows[y].some(([s, e]) => x >= s && x < e)) { hems.push(y); break; }
  hems.sort((a, b) => a - b);
  if (hems.length) points.hemCenter = { x: center / w, y: hems[hems.length >> 1] / h };
  return points;
}
