import { artworkBackgroundContract, type ArtworkBackgroundContract, type ArtworkBackgroundInput } from './artwork-background-contract';

/** Explicit foreground preservation, separate from generic background removal. */
export const ARTWORK_PROTECTION_VERSION = 'explicit-panel-protection-v1';
export type ArtworkProtectionPolicy = { version: typeof ARTWORK_PROTECTION_VERSION; keepRedPanels: boolean; background?: ArtworkBackgroundContract };
export type PixelRegion = { left: number; top: number; width: number; height: number };
export function artworkProtectionPolicy(instruction: string, layoutNote = '', context: Omit<ArtworkBackgroundInput, 'instruction' | 'layoutNote'> = {}): ArtworkProtectionPolicy {
  const clauses = `${instruction}\n${layoutNote}`.replace(/不要去掉|不得去掉|不去掉/gu, '保留').split(/[，,。；;\n]/u);
  const keepRedPanels = clauses.some(clause => /(?:保留|保持|保护|不要去掉|不去掉|不得去掉).{0,24}(?:红底|红色底|红色.*(?:底形|底块|底板|背景))|(?:红底|红色底|红色.*(?:底形|底块|底板|背景)).{0,24}(?:保留|保持|保护|不去掉)/u.test(clause)
    && !/(?:不保留|不要保留|无需保留|去掉红|删除红)/u.test(clause));
  const background = artworkBackgroundContract({ ...context, instruction, layoutNote });
  return { version: ARTWORK_PROTECTION_VERSION, keepRedPanels, ...(background.scope === 'legacy' ? {} : { background }) };
}
/** Detect only large, closed, axis-aligned red panels. Never guess arbitrary semantic regions. */
export function redPanelRegions(rgba: Uint8Array, width: number, height: number): PixelRegion[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 25_000_000 || rgba.length !== width * height * 4) throw new Error('图像尺寸或像素缓冲无效');
  const count = width * height, red = new Uint8Array(count), visited = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    const i = p * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (rgba[i + 3] >= 240 && r >= 110 && r - g >= 55 && r - b >= 45 && r > g * 1.4 && r > b * 1.3) red[p] = 1;
  }
  const queue = new Int32Array(count), regions: PixelRegion[] = [];
  for (let seed = 0; seed < count; seed++) {
    if (!red[seed] || visited[seed]) continue;
    let head = 0, tail = 1, left = width, top = height, right = 0, bottom = 0;
    queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      const neighbors = [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, y > 0 ? p - width : -1, y + 1 < height ? p + width : -1];
      for (const next of neighbors) if (next >= 0 && red[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
    }
    const w = right - left + 1, h = bottom - top + 1, area = w * h;
    if (w < 16 || h < 12 || area < 256 || tail / area < 0.45) continue;
    const edgeRatio = (horizontal: boolean, fixed: number) => {
      let n = 0, total = 0;
      const from = horizontal ? left : top, to = horizontal ? right : bottom;
      for (let p = from + 2; p <= to - 2; p++) { total++; n += red[(horizontal ? fixed * width + p : p * width + fixed)]; }
      return total > 0 ? n / total : 0;
    };
    if ([edgeRatio(true, top), edgeRatio(true, bottom), edgeRatio(false, left), edgeRatio(false, right)].some(ratio => ratio < 0.88)) continue;
    regions.push({ left, top, width: w, height: h });
  }
  return regions;
}
export function restoreProtectedRgba(source: Uint8Array, result: Uint8Array, width: number, height: number, regions: PixelRegion[]): Uint8Array {
  if (source.length !== width * height * 4 || result.length !== source.length) throw new Error('保护区恢复前后图片尺寸不一致');
  const output = new Uint8Array(result);
  for (const r of regions) {
    if (![r.left, r.top, r.width, r.height].every(Number.isSafeInteger) || r.left < 0 || r.top < 0 || r.width <= 0 || r.height <= 0 || r.left + r.width > width || r.top + r.height > height) throw new Error('保护区域越界');
    for (let y = r.top; y < r.top + r.height; y++) {
      const start = (y * width + r.left) * 4, end = start + r.width * 4;
      output.set(source.subarray(start, end), start);
    }
  }
  return output;
}
