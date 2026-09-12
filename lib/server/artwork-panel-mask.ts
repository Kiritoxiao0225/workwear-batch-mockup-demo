import sharp from 'sharp';
import type { ArtworkProtectionPolicy, PixelRegion } from '@/lib/artwork-protection';
import { alphaMaskReport, assertUsableArtworkMask } from './artwork-image-processing';
import { pixelComponents } from './artwork-foreground-integrity';

export type RedPanelSilhouette = PixelRegion & { spans: Array<[number, number]>; rounded: boolean };
const isRed = (data: Uint8Array, i: number) => data[i + 3] >= 240 && data[i] >= 110 && data[i] - data[i + 1] >= 55 && data[i] - data[i + 2] >= 45 && data[i] > data[i + 1] * 1.4 && data[i] > data[i + 2] * 1.3;

/** Narrow proof for an axis-aligned red panel with white lettering. A contour is
 * not its bounding rectangle: excluded rounded corners must never be restored. */
export function redPanelSilhouettes(data: Uint8Array, width: number, height: number): RedPanelSilhouette[] {
  if (data.length !== width * height * 4 || width * height > 25_000_000) throw new Error('底形像素缓冲无效');
  const red = new Uint8Array(width * height);
  for (let p = 0; p < red.length; p++) if (isRed(data, p * 4)) red[p] = 1;
  const { labels, regions } = pixelComponents(red, width, height);
  const panels: RedPanelSilhouette[] = [];
  for (const region of regions) {
    const { left, top, width: w, height: h, label, count } = region;
    if (w < 16 || h < 12 || count / (w * h) < .45) continue;
    const spans: Array<[number, number]> = [];
    let valid = true;
    for (let y = top; y < top + h; y++) {
      let first = left + w, last = -1;
      for (let x = left; x < left + w; x++) if (labels[y * width + x] === label) { first = Math.min(first, x); last = x; }
      if (last < first) { valid = false; break; }
      // Original pixels inside the panel must be opaque red/neutral white, not
      // a guessed background, hole, unrelated colourful object or soft mask.
      for (let x = first; x <= last; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < 240 || !(red[y * width + x] || Math.min(data[i], data[i + 1], data[i + 2]) >= 210 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) <= 30 || data[i] >= 200 && data[i] >= data[i + 1] && data[i] >= data[i + 2] && Math.abs(data[i + 1] - data[i + 2]) <= 25)) { valid = false; break; }
      }
      spans.push([first, last]);
    }
    if (!valid || spans.length !== h) continue;
    const maxInset = Math.min(w, h) * .35;
    for (let y = 0; y < h; y++) {
      const [a, b] = spans[y], [ma, mb] = spans[h - 1 - y];
      if (Math.abs((a - left) - (left + w - 1 - b)) > 2 || Math.abs(a - ma) > 2 || Math.abs(b - mb) > 2 || a - left > maxInset) { valid = false; break; }
      if (y >= h * .35 && y <= h * .65 && (a > left + 1 || b < left + w - 2)) { valid = false; break; }
      if (y > 0 && y < h / 2 && (a > spans[y - 1][0] + 1 || b < spans[y - 1][1] - 1)) { valid = false; break; }
    }
    if (valid) panels.push({ left, top, width: w, height: h, spans, rounded: spans[0][0] > left && spans[h - 1][0] > left });
  }
  return panels;
}

export function restorePanelPixels(source: Uint8Array, result: Uint8Array, width: number, panels: RedPanelSilhouette[]) {
  if (source.length !== result.length) throw new Error('保护区恢复尺寸不一致');
  const output = Buffer.from(result);
  for (const panel of panels) for (let row = 0; row < panel.height; row++) {
    const [left, right] = panel.spans[row], start = ((panel.top + row) * width + left) * 4;
    output.set(source.subarray(start, start + (right - left + 1) * 4), start);
  }
  return output;
}

/** Keep the global 5% gate unchanged. Only a pixel-proven, explicitly protected
 * full-bleed rounded panel can use this exception. No all-opaque image qualifies. */
export async function assertArtworkMask(bytes: Buffer, policy?: ArtworkProtectionPolicy) {
  const report = await alphaMaskReport(bytes);
  try { assertUsableArtworkMask(report); return { report, acceptance: 'standard' as const }; }
  catch (error) {
    if (!policy?.keepRedPanels || report.visibleRatio < .005 || report.coreOpaqueAmongVisible < .25 || report.softAlphaAmongVisible > .75) throw error;
    const { data, info } = await sharp(bytes).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const panel = redPanelSilhouettes(data, width, height).find(p => p.rounded && p.left === 0 && p.top === 0 && p.width === width && p.height === height);
    if (!panel) throw error;
    let inside = 0, outside = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [left, right] = panel.spans[y];
      if (x >= left && x <= right) inside++;
      else { outside++; if (data[(y * width + x) * 4 + 3] > 8) throw error; }
    }
    if (outside < 4 || inside / (width * height) < .95) throw error;
    return { report, acceptance: 'explicit-full-bleed-panel' as const };
  }
}

/** Validation-only expected foreground for the explicit full-bleed panel case.
 * It is not a production cutout. White exterior corners otherwise outvote the
 * small background estimate while the red perimeter looks like a background. */
export async function panelIntegritySource(source: Buffer, policy?: ArtworkProtectionPolicy) {
  if (!policy?.keepRedPanels) return source;
  const { data, info } = await sharp(source).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const panel = redPanelSilhouettes(data, width, height).find(p => p.rounded && p.left === 0 && p.top === 0 && p.width === width && p.height === height);
  if (!panel) return source;
  let outside = 0;
  const expected = Buffer.from(data);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [left, right] = panel.spans[y];
    if (x >= left && x <= right) continue;
    const i = (y * width + x) * 4;
    if (data[i + 3] > 8 && Math.min(data[i], data[i + 1], data[i + 2]) < 240) return source;
    expected[i + 3] = 0; outside++;
  }
  if (outside < 4 || outside / (width * height) > .05) return source;
  return sharp(expected, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
