import sharp from 'sharp';
import type { ArtworkPixelBounds } from './artwork-image-processing';

export const ARTWORK_INTEGRITY_VERSION = 'artwork-integrity-v1';
type Sample = { x: number; y: number; rgb: number[]; edge: number };
export type BackgroundField = { coefficients: number[][]; tolerance: number; support: number };
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function backgroundAt(field: BackgroundField, x: number, y: number) {
  return field.coefficients.map(([a, b, c]) => Math.max(0, Math.min(255, a * x + b * y + c)));
}

/** Robust planar background evidence, not a cutout mask. Perimeter foreground is
 * an outlier, not a reason to disable completeness checks. Gradients are allowed;
 * textured/multimodal scenes without a supported field remain explicitly unknown. */
export function estimateArtworkBackground(data: Uint8Array, width: number, height: number): BackgroundField | null {
  const samples: Sample[] = [];
  const radius = Math.max(0, Math.min(3, Math.floor(Math.min(width, height) / 150)));
  for (let edge = 0; edge < 4; edge++) for (let k = 0; k < 12; k++) {
    const f = (k + .5) / 12;
    const x = Math.round(edge < 2 ? f * (width - 1) : edge === 2 ? radius : width - 1 - radius);
    const y = Math.round(edge >= 2 ? f * (height - 1) : edge === 0 ? radius : height - 1 - radius);
    const pixels: number[][] = [];
    for (let sy = Math.max(0, y - radius); sy <= Math.min(height - 1, y + radius); sy++) for (let sx = Math.max(0, x - radius); sx <= Math.min(width - 1, x + radius); sx++) {
      const i = (sy * width + sx) * 4;
      if (data[i + 3] >= 240) pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (!pixels.length) continue;
    const rgb = [0, 1, 2].map(c => pixels.map(p => p[c]).sort((a, b) => a - b)[Math.floor(pixels.length / 2)]);
    if (pixels.filter(p => distance(p, rgb) <= 18).length < pixels.length * .9) continue;
    samples.push({ x: x / Math.max(1, width - 1), y: y / Math.max(1, height - 1), rgb, edge });
  }
  // Do not certify a field based on a tiny surviving patch of a busy perimeter.
  if (samples.length < 24) return null;
  let best: { coefficients: number[][]; inliers: Sample[]; error: number } | undefined;
  const evaluate = (coefficients: number[][]) => {
    const field = { coefficients, tolerance: 0, support: 0 };
    const inliers = samples.filter(s => distance(backgroundAt(field, s.x, s.y), s.rgb) <= 18);
    if (inliers.length < 27 || new Set(inliers.map(s => s.edge)).size < 3) return;
    const error = inliers.reduce((sum, s) => sum + distance(backgroundAt(field, s.x, s.y), s.rgb), 0);
    if (!best || inliers.length > best.inliers.length || inliers.length === best.inliers.length && error < best.error) best = { coefficients, inliers, error };
  };
  for (const sample of samples) evaluate(sample.rgb.map(value => [0, 0, value]));
  // Deterministic RANSAC, no random seed or provider-derived "background" labels.
  const anchors = samples.filter((_, i) => i % 2 === 0);
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) for (let k = j + 1; k < anchors.length; k++) {
    const [p, q, r] = [anchors[i], anchors[j], anchors[k]];
    const det = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
    if (Math.abs(det) < .1) continue;
    evaluate([0, 1, 2].map(c => {
      const a = ((q.rgb[c] - p.rgb[c]) * (r.y - p.y) - (r.rgb[c] - p.rgb[c]) * (q.y - p.y)) / det;
      const b = ((q.x - p.x) * (r.rgb[c] - p.rgb[c]) - (r.x - p.x) * (q.rgb[c] - p.rgb[c])) / det;
      return [a, b, p.rgb[c] - a * p.x - b * p.y];
    }));
  }
  if (!best) return null;
  return { coefficients: best.coefficients, tolerance: Math.max(48, best.error / best.inliers.length * 4 + 18), support: best.inliers.length / 48 };
}

export async function artworkForegroundEvidence(bytes: Buffer) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 25_000_000 }).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info, mask = new Uint8Array(width * height);
  let transparent = 0;
  for (let p = 0; p < mask.length; p++) if (data[p * 4 + 3] <= 8) transparent++;
  const alphaSource = transparent > 0;
  const background = alphaSource ? null : estimateArtworkBackground(data, width, height);
  if (!alphaSource && !background) return { data, width, height, mask, kind: 'unknown' as const, background };
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    if (data[i + 3] < (alphaSource ? 64 : 200)) continue;
    if (alphaSource || distance(data.subarray(i, i + 3), backgroundAt(background!, (p % width) / Math.max(1, width - 1), Math.floor(p / width) / Math.max(1, height - 1))) > background!.tolerance) mask[p] = 1;
  }
  return { data, width, height, mask, kind: alphaSource ? 'alpha' as const : 'background-field' as const, background };
}

export function pixelComponents(mask: Uint8Array, width: number, height: number, classes?: Uint16Array) {
  const labels = new Int32Array(mask.length), queue = new Int32Array(mask.length);
  const regions: Array<ArtworkPixelBounds & { count: number; label: number }> = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed]) continue;
    const label = regions.length + 1;
    let head = 0, tail = 1, left = width, right = 0, top = height, bottom = 0;
    queue[0] = seed; labels[seed] = label;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (mask[q] && !labels[q] && (!classes || classes[q] === classes[seed])) { labels[q] = label; queue[tail++] = q; }
      }
    }
    regions.push({ left, top, width: right - left + 1, height: bottom - top + 1, count: tail, label });
  }
  return { labels, regions };
}

export async function inspectArtworkCompleteness(source: Buffer, output: Buffer, minimumAlpha = 64) {
  const evidence = await artworkForegroundEvidence(source);
  const { data, info } = await sharp(output).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.width !== evidence.width || info.height !== evidence.height) throw new Error('抠图前后画布尺寸不一致，请核对完整图案与排版');
  if (evidence.kind === 'unknown') return { status: 'uncertain' as const, missingRegions: [] as ArtworkPixelBounds[], addedRegions: [] as ArtworkPixelBounds[], basis: evidence.kind };
  const { labels, regions } = pixelComponents(evidence.mask, evidence.width, evidence.height);
  const retained = new Uint32Array(regions.length + 1);
  for (let p = 0; p < labels.length; p++) if (labels[p] && data[p * 4 + 3] >= minimumAlpha) retained[labels[p]]++;
  const marked = regions.filter(r => r.count >= 6).map(r => ({ ...r, missing: retained[r.label] / r.count < .8 }));
  // A surviving large component must not hide the complete loss of a smaller
  // attached stroke. Same 80% retention contract, evaluated locally as well.
  for (const r of marked) {
    if (r.missing || r.count < 1024) continue;
    for (let y = r.top; y < r.top + r.height && !r.missing; y += 32) for (let x = r.left; x < r.left + r.width; x += 32) {
      let count = 0, kept = 0;
      for (let sy = y; sy < Math.min(y + 32, r.top + r.height); sy++) for (let sx = x; sx < Math.min(x + 32, r.left + r.width); sx++) {
        const p = sy * evidence.width + sx;
        if (labels[p] !== r.label) continue;
        count++; if (data[p * 4 + 3] >= minimumAlpha) kept++;
      }
      if (count >= 6 && kept / count < .8) { r.missing = true; break; }
    }
  }
  // Embedded white letters and small coloured details can share one alpha
  // component with a backing panel. Check their colour-connected identity too;
  // this is an alpha-retention check, not a model colour-fidelity verdict.
  const classes = new Uint16Array(evidence.mask.length);
  for (let p = 0; p < classes.length; p++) {
    const i = p * 4;
    classes[p] = (evidence.data[i] >> 5) * 64 + (evidence.data[i + 1] >> 5) * 8 + (evidence.data[i + 2] >> 5);
  }
  const coloured = pixelComponents(evidence.mask, evidence.width, evidence.height, classes);
  const colourKept = new Uint32Array(coloured.regions.length + 1);
  for (let p = 0; p < classes.length; p++) if (coloured.labels[p] && data[p * 4 + 3] >= minimumAlpha) colourKept[coloured.labels[p]]++;
  for (const r of coloured.regions) if (r.count >= 6 && colourKept[r.label] / r.count < .8) marked.push({ ...r, missing: true });
  const additions = new Uint8Array(evidence.mask.length);
  if (evidence.kind === 'alpha') for (let p = 0; p < additions.length; p++) if (evidence.data[p * 4 + 3] <= 8 && data[p * 4 + 3] >= minimumAlpha) additions[p] = 1;
  const addedRegions = pixelComponents(additions, evidence.width, evidence.height).regions.filter(r => r.count >= 6)
    .map(({ left, top, width, height }) => ({ left, top, width, height }));
  // Keep overlapping marks together (e.g. registered R and its intact ring).
  for (let i = 0; i < marked.length; i++) for (let j = i + 1; j < marked.length; j++) {
    const a = marked[i], b = marked[j];
    if (a.left >= b.left + b.width || b.left >= a.left + a.width || a.top >= b.top + b.height || b.top >= a.top + a.height) continue;
    const right = Math.max(a.left + a.width, b.left + b.width), bottom = Math.max(a.top + a.height, b.top + b.height);
    a.left = Math.min(a.left, b.left); a.top = Math.min(a.top, b.top); a.width = right - a.left; a.height = bottom - a.top; a.missing ||= b.missing;
    marked.splice(j, 1); i = -1; break;
  }
  const missingRegions = marked.filter(r => r.missing).map(({ left, top, width, height }) => ({ left, top, width, height })).sort((a, b) => a.top - b.top || a.left - b.left);
  const foreground = regions.reduce((sum, r) => sum + r.count, 0);
  return { status: missingRegions.length || addedRegions.length ? 'failed' as const : foreground ? 'checked' as const : 'uncertain' as const, missingRegions, addedRegions, basis: evidence.kind };
}
